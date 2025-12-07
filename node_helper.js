/* MagicMirror² Node Helper for MMM-myStrom (patched & improved)
 * - Devices are ALWAYS polled (even if offline at MM startup)
 * - Device type is dynamically auto-detected during polling
 * - UNKNOWN devices reclassify automatically
 * - PIR coming online later now works correctly
 */

const NodeHelper = require("node_helper");
const axios = require("axios");
const nodemailer = require("nodemailer");

const fs = require("fs");
const path = require("path");


// Load translations
let translations = {};

function loadTranslations() {
  const lang = (global.config.language || "en").toLowerCase();
  const file = path.resolve(__dirname, "translations", `${lang}.json`);

  if (fs.existsSync(file)) {
    translations = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    translations = JSON.parse(fs.readFileSync(path.resolve(__dirname, "translations/en.json"), "utf8"));
  }
}

function t(key) {
  return translations[key] || key;
}

module.exports = NodeHelper.create({
  start() {
    console.log("[MMM-myStrom] node_helper start");
    this.rooms = [];
    this.devices = []; // flat list: { room, name, ip, type }
    this.timers = {};
    this.timeoutMs = 4000;
    loadTranslations();
    console.log("[MMM-myStrom] Node helper started with language translations");
  },

  stop() {
    for (const t of Object.values(this.timers)) clearInterval(t);
    this.timers = {};
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "MMM_MYStrom_CONFIG") {
      console.log("[MMM-myStrom] received CONFIG");
      this.rooms = payload.rooms || [];
      this.timeoutMs = payload.timeoutMs || 4000;
      this.emailAlert = payload.emailAlert || { enabled: false };

      this.devices = [];
      for (const room of this.rooms) {
        for (const d of room.devices) {
          this.devices.push({ room: room.room, name: d.name, ip: d.ip, type: null });
        }
      }

      // No more one-time detectAll()
      // Instead, we set up polling for ALL devices and dynamically detect type
      this.setupPolling(payload);
    }

    else if (notification === "MMM_MYStrom_EMAIL_ALERT") {
      this.sendEmailAlert(payload);
    }
  },

  /* ---------------------------------------------------------------
   *  Play alert sound
   * --------------------------------------------------------------- */
  _playSound(path) {
    const audio = new Audio(path);
    audio.volume = 100.0;
    audio.play().catch(err => {
      console.warn("[MMM-myStrom] Audio playback failed:", err);
    });
  },

  /* ---------------------------------------------------------------
   *  Send alert email
   * --------------------------------------------------------------- */
  async sendEmailAlert(alert) {
    if (!this.emailAlert || !this.emailAlert.enabled) {
      return; // email alerts disabled
    }

    const cfg = this.emailAlert;

    // Validate config
    if (!cfg.smtp?.host || !cfg.smtp?.auth?.user || !cfg.smtp?.auth?.pass) {
      console.error("[MMM-myStrom] Email alert missing SMTP configuration");
      return;
    }

    if (!cfg.from || !cfg.to) {
      console.error("[MMM-myStrom] Email alert missing 'from' or 'to' address");
      return;
    }

    try {
      const transporter = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        auth: {
          user: cfg.smtp.auth.user,
          pass: cfg.smtp.auth.pass
        }
      });

      const subjectKey = {
        "OFFON": "EMAIL_SUBJECT_ON",
        "ONOFF": "EMAIL_SUBJECT_OFF",
        "POWER": "EMAIL_SUBJECT_POWER",
        "POWER_NORMAL": "EMAIL_SUBJECT_POWER_NORMAL",
        "PIR_CLEAR": "EMAIL_SUBJECT_PIR_CLEAR"
      }[alert.alertType] || "EMAIL_ALERT_TYPE";

      const subject = `${t(subjectKey)} - ${alert.name || alert.ip}`;

      let text = "";
      text += `${t("EMAIL_DEVICE")}: ${alert.name || alert.ip}\n`;
      text += `${t("EMAIL_TYPE")}: ${alert.type}\n`;

      if (alert.room) text += `${t("EMAIL_ROOM")}: ${alert.room}\n`;
      if (alert.power !== undefined) text += `${t("EMAIL_POWER")}: ${alert.power} W\n`;
      if (alert.threshold !== undefined) text += `${t("EMAIL_THRESHOLD")}: ${alert.threshold} W\n`;

      text += `${t("EMAIL_ALERT_TYPE")}: ${alert.alertType}\n`;
      text += `${t("EMAIL_TIME")}: ${new Date().toLocaleString()}\n`;

      await transporter.sendMail({
        from: cfg.from,
        to: cfg.to,
        subject: subject,
        text: text
      });

      console.log("[MMM-myStrom] Email alert sent:", subject);

    } catch (err) {
      console.error("[MMM-myStrom] Email send failed:", err);
    }
  },

  /* Allow per-device email alert enable/disable */
  deviceEmailEnabled(dev) {
    if (typeof dev.email === "boolean") return dev.email;
    return this.config.defaultEmailAlert;
  },


  /* ---------------------------------------------------------------
   *  Poll ALL devices. Type is detected on demand.
   * --------------------------------------------------------------- */
  setupPolling(cfg) {
    const interval = Math.min(
      cfg.PIRUpdateInterval,
      cfg.SwitchUpdateInterval,
      cfg.BulbUpdateInterval
    );

    // Fallback if all intervals were missing
    const finalInterval = interval || 5000;

    // Clear previous polling
    for (const t of Object.values(this.timers)) clearInterval(t);
    this.timers = {};

    console.log("[MMM-myStrom] starting universal polling at", finalInterval, "ms");

    this.timers.ALL = setInterval(async () => {
      const results = await Promise.all(
        this.devices.map(async (dev) => {
          try {
            // 1) Detect type if missing or unknown
            if (!dev.type || dev.type === "UNKNOWN") {
              try {
                const t = await this.detectDeviceType(dev.ip);
                if (t && t !== "UNKNOWN") {
                  console.log("[MMM-myStrom] Device reclassified:", dev.ip, "->", t);
                  dev.type = t;
                }
              } catch (e) {
                // still unknown
              }
            }

            // 2) Attempt to read device (might also detect type implicitly)
            const values = await this.readOnce(dev);

            return {
              ip: dev.ip,
              type: dev.type || "UNKNOWN",
              values,
              ts: Date.now(),
              error: null,
              name: dev.name,
              room: dev.room
            };
          } catch (err) {
            return {
              ip: dev.ip,
              type: dev.type || "UNKNOWN",
              values: null,
              ts: Date.now(),
              error: this.fmtError(err),
              name: dev.name,
              room: dev.room
            };
          }
        })
      );

      this.sendSocketNotification("MMM_MYStrom_BULK", results);
    }, finalInterval);
  },

  /* ---------------------------------------------------------------
   * Device Type Detection (auto retries during polling)
   * --------------------------------------------------------------- */
  async detectDeviceType(ip) {
    const urls = [
      `http://${ip}/api/v1/device`,
      `http://${ip}/report`,
      `http://${ip}/api/v1/sensors`,
      `http://${ip}/rest?get=report`,
    ];

    for (const url of urls) {
      try {
        const res = await axios.get(url, { timeout: this.timeoutMs });
        const data = typeof res.data === "string" ? this.tryJson(res.data) : res.data;
        if (data && typeof data === "object") {
          const body = this.unwrapKeyed(data);
          if (body) {
            if ("motion" in body) return "PIR";
            if ("relay" in body) return "SWITCH";
            if ("on" in body || "color" in body) return "BULB";
          }
        }
      } catch (e) {
        // Try next endpoint
      }
    }
    return "UNKNOWN";
  },

  /* ---------------------------------------------------------------
   * readOnce(): Also updates type automatically if data matches
   * --------------------------------------------------------------- */
  async readOnce(dev) {
    const urlCandidates = [
      `http://${dev.ip}/api/v1/device`,
      `http://${dev.ip}/report`,
      `http://${dev.ip}/api/v1/sensors`,
      `http://${dev.ip}/rest?get=report`,
    ];

    let data = null;
    let lastErr = null;

    for (const url of urlCandidates) {
      try {
        const res = await axios.get(url, { timeout: this.timeoutMs });
        data = typeof res.data === "string" ? this.tryJson(res.data) : res.data;
        if (data) break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!data) throw lastErr || new Error("No data");

    const body = this.unwrapKeyed(data) || data;

    // Auto refine type detection from returned values
    if (!dev.type || dev.type === "UNKNOWN") {
      if ("motion" in body) dev.type = "PIR";
      else if ("relay" in body) dev.type = "SWITCH";
      else if ("on" in body || "color" in body) dev.type = "BULB";
    }

    /* ---- Format according to (possibly newly detected) type ---- */

    if (dev.type === "PIR") {
      return {
        motion: this._readBool(body.motion),
        light: body.light,
        temperature: body.temperature,
      };
    }

    if (dev.type === "SWITCH") {
      return {
        relay: this._readBool(body.relay),
        power: body.power,
        temperature: body.temperature,
      };
    }

    if (dev.type === "BULB") {
      const out = {
        on: this._readBool(body.on),
        color: body.color,
        power: body.power,
        colorHex: null
      };

      try {
        const parsedHex = parseColorToHex(body);
        if (parsedHex) out.colorHex = parsedHex;
      } catch (err) {
        console.warn("[MMM-myStrom] color parse error:", dev.ip, err);
      }

      return out;
    }

    return body;
  },

  /* ---------------------------------------------------------------
   * Utility Helpers
   * --------------------------------------------------------------- */
  unwrapKeyed(obj) {
    if (!obj || typeof obj !== "object") return null;
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj[keys[0]] === "object") return obj[keys[0]];
    return obj;
  },

  tryJson(txt) {
    try { return JSON.parse(txt); } catch { return null; }
  },

  _readBool(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.toLowerCase() === "true" || v === "1";
    return undefined;
  },

  fmtError(err) {
    if (!err) return "ERROR_UNKNOWN";
    if (err.code === 'ECONNABORTED') return "DEVICE_TIMEOUT";
    if (err.response && err.response.status) return `HTTP ${err.response.status}`;
    if (err.request) return "NO_RESPONSE";
    return err.message || String(err);
  },
});

/* ---------------------------------------------------------------
 * Color parsing + helpers
 * --------------------------------------------------------------- */
// Main parse function: accepts body objects or strings and returns normalized hex (#RRGGBB) or null
function parseColorToHex(body) {
  if (!body) return null;

  // 1) If body.color is an object {r,g,b} or {red,green,blue}
  if (body.color && typeof body.color === "object") {
    const c = body.color;
    const r = (c.r !== undefined ? c.r : c.red);
    const g = (c.g !== undefined ? c.g : c.green);
    const b = (c.b !== undefined ? c.b : c.blue);
    if (isFiniteNumber(r) && isFiniteNumber(g) && isFiniteNumber(b)) {
      return rgbToHex(Number(r), Number(g), Number(b));
    }
  }

  // 2) If body.color is a string, handle multiple formats
  if (typeof body.color === "string") {
    let s = body.color.trim();

    // Strip weird characters but keep separators ; , spaces and # and digits/letters for hex
    s = s.replace(/[^\dA-Fa-f#;,.\s-]/g, "").trim();
    if (!s) return null;

    const mode = (body.mode && typeof body.mode === "string") ? body.mode.toLowerCase() : "";

    // HSV-like: either mode hint or semicolon present
    if (mode.includes("hsv") || s.includes(";")) {
      const hex = parseHSVStringToBestHex(s);
      if (hex) return hex;
    }

    // Some devices might use commas for hsv or indicate hsv in mode
    if (s.includes(",") && mode.includes("hsv")) {
      const hex = parseHSVStringToBestHex(s);
      if (hex) return hex;
    }

    // RGB triplet: "R,G,B" or "R G B"
    if (s.includes(",") || s.split(/\s+/).length === 3) {
      const parts = s.split(/[,\s]+/).map(p => p.trim()).filter(Boolean).map(Number);
      if (parts.length >= 3 && parts.slice(0,3).every(isFiniteNumber)) {
        let [R,G,B] = parts.slice(0,3).map(Number);
        // if in 0..1 range, scale to 0..255
        if (R <= 1 && G <= 1 && B <= 1) {
          R = Math.round(R * 255); G = Math.round(G * 255); B = Math.round(B * 255);
        }
        return rgbToHex(R, G, B);
      }
    }

    // Hex like "rrggbb", "#rrggbb", "fff"
    let hexCand = s.replace(/[^0-9A-Fa-f#]/g, "");
    if (!hexCand) return null;
    if (!hexCand.startsWith("#")) hexCand = "#" + hexCand;
    if (/^#[0-9A-Fa-f]{3}$/.test(hexCand)) {
      // expand #abc -> #aabbcc
      const a = hexCand[1], b = hexCand[2], c = hexCand[3];
      hexCand = `#${a}${a}${b}${b}${c}${c}`;
    }
    if (/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(hexCand)) {
      return hexCand.toUpperCase();
    }

    return null;
  }

  // 3) If body itself is a string, try to parse it like {color: body}
  if (typeof body === "string") {
    return parseColorToHex({ color: body });
  }

  return null;
}

// Parse HSV-like string with heuristic fallback
function parseHSVStringToBestHex(hStr) {
  const parts = String(hStr || "").trim().split(/[;,]/).map(p => p.trim()).filter(Boolean).map(Number);
  if (parts.length < 2 || parts.some(p => Number.isNaN(p))) return null;
  const H = parts[0];
  const A = parts[1];
  const B = parts.length >= 3 ? parts[2] : parts[1];

  const FORCED_V = 80; // always use full brightness

  // Interpret as H,S,V (with V forced)
  const hex1 = hsvToHex(H, A, FORCED_V);
  // Swapped interpretation H,V,S -> treat the other component as saturation, still forced V
  const hex2 = hsvToHex(H, B, FORCED_V);

  const hue = ((Number(H) % 360) + 360) % 360;
  if (hue >= 30 && hue <= 90) {
    const [r1, g1] = hexToRGB(hex1);
    const [r2, g2] = hexToRGB(hex2);

    const ratio1 = g1 === 0 ? (r1 > 0 ? Infinity : 1) : r1 / g1;
    const ratio2 = g2 === 0 ? (r2 > 0 ? Infinity : 1) : r2 / g2;

    // prefer the result where R and G are closer to each other for yellow hues
    if (Math.abs(ratio2 - 1) + 0.0001 < Math.abs(ratio1 - 1)) {
      console.log("[MMM-myStrom] HSV fallback used (H,V,S) for", hStr, "->", hex2);
      return hex2;
    }
  }

  return hex1;
}


function hsvToHex(h, s, v) {
  h = Number(h) || 0;
  s = Number(s) || 0;
  v = Number(v) || 0;

  // Normalize s and v to 0..1 if they are given as percentages (0..100)
  if (s > 1) s = Math.max(0, Math.min(100, s)) / 100;
  if (v > 1) v = Math.max(0, Math.min(100, v)) / 100;

  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;

  if (hh >= 0 && hh < 60)        { r = c; g = x; b = 0; }
  else if (hh >= 60 && hh < 120) { r = x; g = c; b = 0; }
  else if (hh >= 120 && hh < 180){ r = 0; g = c; b = x; }
  else if (hh >= 180 && hh < 240){ r = 0; g = x; b = c; }
  else if (hh >= 240 && hh < 300){ r = x; g = 0; b = c; }
  else                            { r = c; g = 0; b = x; }

  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);

  return rgbToHex(R, G, B);
}

function rgbToHex(r, g, b) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
  const R = clamp(r), G = clamp(g), B = clamp(b);
  return `#${[R, G, B].map(n => n.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function hexToRGB(hex) {
  const n = (hex || "").replace("#", "");
  if (!/^[0-9A-Fa-f]{6}$/.test(n)) return [0,0,0];
  return [parseInt(n.substr(0,2),16), parseInt(n.substr(2,2),16), parseInt(n.substr(4,2),16)];
}

function isFiniteNumber(v) { return typeof v === "number" && Number.isFinite(v); }