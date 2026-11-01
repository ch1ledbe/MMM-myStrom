/* MagicMirror² Node Helper for MMM-myStrom
 * - Every device is polled in its own loop with the interval of its type
 * - A new request is only started after the previous one finished (no pile-up)
 * - Device type is auto-detected during polling, UNKNOWN devices reclassify automatically
 * - SMTP credentials can be kept out of config.js (secrets.json or environment variables)
 */

const NodeHelper = require("node_helper");
const axios = require("axios");
const nodemailer = require("nodemailer");

const fs = require("fs");
const path = require("path");

const ENDPOINTS = [
  "/api/v1/device",
  "/report",
  "/api/v1/sensors",
  "/rest?get=report",
];

const ALERT_SUBJECT_KEYS = {
  OFFON: "EMAIL_SUBJECT_ON",
  ONOFF: "EMAIL_SUBJECT_OFF",
  POWER: "EMAIL_SUBJECT_POWER",
  POWER_NORMAL: "EMAIL_SUBJECT_POWER_NORMAL",
  PIR_CLEAR: "EMAIL_SUBJECT_PIR_CLEAR"
};

const MIN_INTERVAL_MS = 1000;
const DEFAULT_EMAIL_COOLDOWN_MS = 60000;
const MAX_RESPONSE_BYTES = 64 * 1024;

// Hostname, IPv4 address or either of them with ":port" - nothing that could alter the URL path
const HOST_PATTERN = /^(?=.{1,253}(:\d{1,5})?$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?$/;

const SECRETS_FILE = path.resolve(__dirname, "secrets.json");

// Load translations
let translations = {};

function loadTranslations() {
  const lang = String(global.config?.language || "en").toLowerCase().replace(/[^a-z-]/g, "");
  const file = path.resolve(__dirname, "translations", `${lang}.json`);
  const fallback = path.resolve(__dirname, "translations", "en.json");

  translations = JSON.parse(fs.readFileSync(fs.existsSync(file) ? file : fallback, "utf8"));
}

function t(key) {
  return translations[key] || key;
}

function isValidHost(host) {
  return typeof host === "string" && HOST_PATTERN.test(host);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source || {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

module.exports = NodeHelper.create({
  start() {
    console.log("[MMM-myStrom] node_helper start");
    this.configured = false;
    this.configJson = null;
    this.devices = []; // flat list: { room, name, ip, type, url }
    this.running = false;
    this.lastResults = {};
    this.emailAlert = { enabled: false };
    this.lastEmailSent = {};
    this.transporter = null;
    loadTranslations();
  },

  stop() {
    this.stopPolling();
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "MMM_MYStrom_CONFIG") {
      this.handleConfig(payload || {});
    } else if (notification === "MMM_MYStrom_EMAIL_ALERT") {
      this.sendEmailAlert(payload || {});
    }
  },

  /* ---------------------------------------------------------------
   *  Configuration
   *  The config is only accepted once per MagicMirror start. Every
   *  browser that opens the mirror sends it again; a different config
   *  from another client is ignored so it cannot redirect polling.
   * --------------------------------------------------------------- */
  handleConfig(payload) {
    const json = JSON.stringify(payload);

    if (this.configured) {
      if (json !== this.configJson) {
        console.warn("[MMM-myStrom] Ignoring a different CONFIG from another client. Restart MagicMirror to apply config changes.");
      }
      // Give the (re)connected client the current state right away
      const results = Object.values(this.lastResults);
      if (results.length) this.sendSocketNotification("MMM_MYStrom_BULK", results);
      return;
    }

    console.log("[MMM-myStrom] received CONFIG");
    this.configured = true;
    this.configJson = json;

    this.timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : 4000;
    this.intervals = {
      PIR: this.sanitizeInterval(payload.PIRUpdateInterval, 10000),
      SWITCH: this.sanitizeInterval(payload.SwitchUpdateInterval, 2000),
      BULB: this.sanitizeInterval(payload.BulbUpdateInterval, 2000),
    };
    this.intervals.UNKNOWN = Math.min(this.intervals.PIR, this.intervals.SWITCH, this.intervals.BULB);

    this.emailAlert = this.resolveEmailConfig(payload.emailAlert);
    this.setupEmailTransport();

    this.devices = [];
    for (const room of Array.isArray(payload.rooms) ? payload.rooms : []) {
      for (const d of Array.isArray(room.devices) ? room.devices : []) {
        const ip = typeof d.ip === "string" ? d.ip.trim() : d.ip;
        const dev = { room: room.room, name: d.name, ip, type: null, url: null, timer: null };

        if (!isValidHost(ip)) {
          console.error("[MMM-myStrom] Invalid device address, device skipped:", d.ip);
          this.publish(dev, null, "INVALID_IP");
          continue;
        }
        this.devices.push(dev);
      }
    }

    this.startPolling();
  },

  sanitizeInterval(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(MIN_INTERVAL_MS, n);
  },

  /* ---------------------------------------------------------------
   *  Polling: one self-scheduling loop per device
   * --------------------------------------------------------------- */
  startPolling() {
    this.stopPolling();
    this.running = true;

    console.log("[MMM-myStrom] polling", this.devices.length, "devices, intervals (ms):", this.intervals);

    for (const dev of this.devices) {
      this.pollDevice(dev);
    }
  },

  stopPolling() {
    this.running = false;
    for (const dev of this.devices) clearTimeout(dev.timer);
  },

  async pollDevice(dev) {
    if (!this.running) return;

    try {
      const values = await this.readOnce(dev);
      this.publish(dev, values, null);
    } catch (err) {
      this.publish(dev, null, this.fmtError(err), err?.response?.status);
    }

    if (!this.running) return;
    const interval = this.intervals[dev.type] || this.intervals.UNKNOWN;
    dev.timer = setTimeout(() => this.pollDevice(dev), interval);
  },

  publish(dev, values, error, errorDetail) {
    const result = {
      ip: dev.ip,
      type: dev.type || "UNKNOWN",
      values,
      ts: Date.now(),
      error,
      errorDetail: errorDetail ?? null,
      name: dev.name,
      room: dev.room,
    };
    this.lastResults[dev.ip] = result;
    this.sendSocketNotification("MMM_MYStrom_DATA", result);
  },

  /* ---------------------------------------------------------------
   * readOnce(): reads the device and detects / refines its type
   * --------------------------------------------------------------- */
  async readOnce(dev) {
    // Try the endpoint that worked last time first
    const urls = ENDPOINTS.map(ep => `http://${dev.ip}${ep}`);
    if (dev.url) urls.sort((a, b) => (a === dev.url ? -1 : b === dev.url ? 1 : 0));

    let fallbackBody = null;
    let lastErr = null;

    for (const url of urls) {
      let data;
      try {
        data = await this.fetchJson(url);
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (!data || typeof data !== "object") continue;

      const body = this.unwrapKeyed(data) || data;
      const detected = this.classify(body);

      if (detected !== "UNKNOWN" && (!dev.type || dev.type === "UNKNOWN" || dev.type === detected)) {
        if (dev.type !== detected) console.log("[MMM-myStrom] Device classified:", dev.ip, "->", detected);
        dev.type = detected;
        dev.url = url;
        return this.formatValues(dev, body);
      }

      if (!fallbackBody) fallbackBody = body;
    }

    if (fallbackBody) return fallbackBody;
    throw lastErr || new Error("No data");
  },

  async fetchJson(url) {
    const res = await axios.get(url, {
      timeout: this.timeoutMs,
      maxRedirects: 0,
      maxContentLength: MAX_RESPONSE_BYTES,
      responseType: "text",
      transformResponse: [d => d],
    });
    return this.tryJson(res.data);
  },

  classify(body) {
    if (!body || typeof body !== "object") return "UNKNOWN";
    if ("motion" in body) return "PIR";
    if ("relay" in body) return "SWITCH";
    if ("on" in body || "color" in body) return "BULB";
    return "UNKNOWN";
  },

  formatValues(dev, body) {
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

    // BULB
    const out = {
      on: this._readBool(body.on),
      color: body.color,
      power: body.power,
      colorHex: null,
    };

    try {
      const parsedHex = parseColorToHex(body);
      if (parsedHex) out.colorHex = parsedHex;
    } catch (err) {
      console.warn("[MMM-myStrom] color parse error:", dev.ip, err);
    }

    return out;
  },

  /* ---------------------------------------------------------------
   *  EMAIL SUPPORT
   * --------------------------------------------------------------- */

  // Priority: environment variables > secrets.json > config.js
  resolveEmailConfig(fromConfig) {
    let cfg = isPlainObject(fromConfig) ? fromConfig : { enabled: false };
    const configHasPassword = Boolean(cfg.smtp?.auth?.pass);

    if (fs.existsSync(SECRETS_FILE)) {
      try {
        const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
        cfg = deepMerge(cfg, secrets.emailAlert || secrets);
        console.log("[MMM-myStrom] Loaded email settings from secrets.json");
      } catch (e) {
        console.error("[MMM-myStrom] Could not read secrets.json:", e.message);
      }
    }

    const env = process.env;
    if (env.MYSTROM_SMTP_USER || env.MYSTROM_SMTP_PASS) {
      cfg = deepMerge(cfg, {
        smtp: {
          auth: {
            ...(env.MYSTROM_SMTP_USER ? { user: env.MYSTROM_SMTP_USER } : {}),
            ...(env.MYSTROM_SMTP_PASS ? { pass: env.MYSTROM_SMTP_PASS } : {}),
          },
        },
      });
    }

    if (cfg.enabled && configHasPassword) {
      console.warn("[MMM-myStrom] SMTP password is set in config.js and is visible to every browser that opens the mirror. Move it to secrets.json or MYSTROM_SMTP_PASS.");
    }

    return cfg;
  },

  setupEmailTransport() {
    const cfg = this.emailAlert;
    this.transporter = null;

    if (!cfg || !cfg.enabled) {
      console.log("[MMM-myStrom] Email disabled");
      return;
    }

    if (!cfg.smtp || !cfg.smtp.host) {
      console.error("[MMM-myStrom] Missing SMTP config");
      return;
    }

    try {
      this.transporter = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port || 587,
        secure: cfg.smtp.secure || false, // true for 465
        auth: cfg.smtp.auth?.user
          ? {
              user: cfg.smtp.auth.user,
              pass: cfg.smtp.auth.pass,
            }
          : undefined,
      });

      console.log("[MMM-myStrom] Email transport initialized");
    } catch (e) {
      console.error("[MMM-myStrom] Failed to initialize transporter:", e.message);
      this.transporter = null;
    }
  },

  async sendEmailAlert(alert) {
    const cfg = this.emailAlert;

    if (!cfg?.enabled) return;

    // Only accept alerts for configured devices and known alert types,
    // and take name/room from our own device list instead of the payload.
    const dev = this.devices.find(d => d.ip === alert.ip);
    const subjectKey = ALERT_SUBJECT_KEYS[alert.alertType];
    if (!dev || !subjectKey) {
      console.warn("[MMM-myStrom] Ignoring email alert for unknown device or alert type:", alert.ip, alert.alertType);
      return;
    }

    // Rate limit per device and alert type
    const cooldown = Number(cfg.cooldownMs) >= 0 ? Number(cfg.cooldownMs) : DEFAULT_EMAIL_COOLDOWN_MS;
    const key = `${dev.ip}|${alert.alertType}`;
    const now = Date.now();
    if (this.lastEmailSent[key] && now - this.lastEmailSent[key] < cooldown) {
      console.log("[MMM-myStrom] Email alert suppressed (cooldown):", key);
      return;
    }

    if (!this.transporter) {
      this.setupEmailTransport();
      if (!this.transporter) {
        console.error("[MMM-myStrom] No email transporter, aborting email");
        return;
      }
    }

    if (!cfg.from || !cfg.to) {
      console.error("[MMM-myStrom] Missing 'from' or 'to' email fields");
      return;
    }

    this.lastEmailSent[key] = now;

    const label = dev.name || dev.ip;
    const subject = `${t(subjectKey)} - ${label}`;
    const power = Number(alert.power);
    const threshold = Number(alert.threshold);

    let text = "";
    text += `${t("EMAIL_DEVICE")}: ${label}\n`;
    text += `${t("EMAIL_TYPE")}: ${dev.type || "UNKNOWN"}\n`;
    if (dev.room) text += `${t("EMAIL_ROOM")}: ${dev.room}\n`;
    if (Number.isFinite(power)) text += `${t("EMAIL_POWER")}: ${power} W\n`;
    if (Number.isFinite(threshold)) text += `${t("EMAIL_THRESHOLD")}: ${threshold} W\n`;
    text += `${t("EMAIL_ALERT_TYPE")}: ${alert.alertType}\n`;
    text += `${t("EMAIL_TIME")}: ${new Date().toLocaleString()}\n`;

    try {
      await this.transporter.sendMail({
        from: cfg.from,
        to: cfg.to,
        subject,
        text,
      });

      console.log("[MMM-myStrom] Email sent:", subject);
    } catch (err) {
      console.error("[MMM-myStrom] Email send error:", err.message);
    }
  },

  /* ---------------------------------------------------------------
   * Utility Helpers
   * --------------------------------------------------------------- */
  unwrapKeyed(obj) {
    if (!obj || typeof obj !== "object") return null;
    const keys = Object.keys(obj);
    if (keys.length === 1 && obj[keys[0]] && typeof obj[keys[0]] === "object") return obj[keys[0]];
    return obj;
  },

  tryJson(txt) {
    if (txt && typeof txt === "object") return txt;
    try {
      return JSON.parse(txt);
    } catch {
      return null;
    }
  },

  _readBool(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.toLowerCase() === "true" || v === "1";
    return undefined;
  },

  fmtError(err) {
    if (!err) return "ERROR_UNKNOWN";
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") return "DEVICE_TIMEOUT";
    if (err.response && err.response.status) return "HTTP_ERROR";
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

    // RGB triplet: "R,G,B" or "R G B"
    if (s.includes(",") || s.split(/\s+/).length === 3) {
      const parts = s.split(/[,\s]+/).map(p => p.trim()).filter(Boolean).map(Number);
      if (parts.length >= 3 && parts.slice(0, 3).every(isFiniteNumber)) {
        let [R, G, B] = parts.slice(0, 3).map(Number);
        // if in 0..1 range, scale to 0..255
        if (R <= 1 && G <= 1 && B <= 1) {
          [R, G, B] = [R, G, B].map(n => Math.round(n * 255));
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

  const FORCED_V = 80; // fixed brightness for a readable swatch

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
  const sector = Math.floor(hh / 60);
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector] || [c, 0, x];

  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);

  return rgbToHex(R, G, B);
}

function rgbToHex(r, g, b) {
  const clamp = n => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
  const R = clamp(r), G = clamp(g), B = clamp(b);
  return `#${[R, G, B].map(n => n.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function hexToRGB(hex) {
  const n = (hex || "").replace("#", "");
  if (!/^[0-9A-Fa-f]{6}$/.test(n)) return [0, 0, 0];
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function isFiniteNumber(v) { return typeof v === "number" && Number.isFinite(v); }
