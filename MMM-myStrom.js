/* MagicMirror² Module: MMM-myStrom
 * Bernie
 * License: MIT
 */

Module.register("MMM-myStrom", {
  defaults: {
    layout: "column", // "inline" | "column"
    showRoomSideBySide: false, //  "false" | "true" put rooms side-by-side
    displayMode: "default", // "default" | "light"
    PIRUpdateInterval: 10000,
    SwitchUpdateInterval: 2000,
    BulbUpdateInterval: 2000,
    timeoutMs: 4000,
    devices: [
      // Example structure
      // { room: "Living Room", devices: [ { name: "PIR 1", ip: "192.168.1.10", alertOffOn: true, alertFile: "alert1.mp3" }, { name: "Switch A", ip: "192.168.1.20" } ] }
    ],
    showTitle: true,
    titleText: "MMM-myStrom",

    // ALERT SYSTEM
    alertEnabled: true, // global master switch

    // Alert sounds per device type ON/OFF
    defaultAlertOffOn: false,
    defaultAlertOnOff: false,

    alertFiles: {
      PIR: "alert1.mp3",
      SWITCH: "alert2.mp3",
      BULB: "alert3.mp3"
    },

    alertFilesOff: {
      PIR: "alert1.mp3",
      SWITCH: "alert2.mp3",
      BULB: "alert3.mp3"
    },

    // Alert sounds per device type POWER
    defaultAlertPower: false,
    defaultAlertPowerNormal: false,
    powerThresholds: {
      SWITCH: 100,
      BULB: 4,
    },
    alertFilesPower: {
      SWITCH: "power1.mp3",
      BULB: "power2.mp3"
    },

    alertFilesPowerNormal: {
      SWITCH: "power1.mp3",
      BULB: "power2.mp3"
    },

    // Alert sound for motion clear (PIR)
    defaultAlertMotionClear: false,
    alertFilesPirClear: {
      PIR: "alert1.mp3"
    },

    // General email alert settings
    emailAlert: {
      enabled: false,
      // SMTP user/password belong in secrets.json or the environment
      // variables MYSTROM_SMTP_USER / MYSTROM_SMTP_PASS, not in config.js
      smtp: {
        host: "",
        port: 587,
        secure: false, // true for port 465, false for 587
      },
      from: "", // Email sender
      to: "", // Email recipient(s), comma-separated allowed
      cooldownMs: 60000, // minimum time between two emails per device and alert type
    },

    // Email alerts for devices without their own "email" option
    defaultEmailAlert: false,

  },

  requiresVersion: "2.20.0",

  start() {
    this.rooms = []; // normalized devices [{room, devices:[{name, ip, type, last, error}]}]
    this.dataByIP = {}; // { ip: { type, values, ts, error, name, room } }
    this.loaded = false;

    // Alert - track last states; the first reading of a device only sets the baseline
    this.lastAlertStates = {}; // { ip: boolean }
    this.lastPowerExceedStates = {}; // { ip: boolean }
    this.lastMotionState = {}; // { ip: boolean }

    // Normalize user's devices array (supports legacy flat keys deviceName1/deviceIP1 ...)
    this.rooms = this.normalizeDevices(this.config.devices || []);

    this.sendSocketNotification("MMM_MYStrom_CONFIG", {
      rooms: this.rooms,
      PIRUpdateInterval: this.config.PIRUpdateInterval,
      SwitchUpdateInterval: this.config.SwitchUpdateInterval,
      BulbUpdateInterval: this.config.BulbUpdateInterval,
      timeoutMs: this.config.timeoutMs,
      emailAlert: this.config.emailAlert || {},
    });
  },

  getStyles() {
    return ["mystrom.css"];
  },

  getTranslations() {
    return {
      en: "translations/en.json",
      de: "translations/de.json",
      fr: "translations/fr.json",
      it: "translations/it.json",
    };
  },

  // Normalize legacy config to the new structure
  normalizeDevices(devices) {
    const rooms = [];
    for (const entry of devices) {
      if (entry.devices && Array.isArray(entry.devices)) {
        rooms.push({ room: entry.room || this.translate("ROOM"), devices: entry.devices });
        continue;
      }
      // Legacy: deviceName1/deviceIP1 ... deviceNameN/deviceIPN
      const room = entry.room || this.translate("ROOM");
      const list = [];
      Object.keys(entry).forEach((k) => {
        const m = k.match(/^deviceName(\d+)$/);
        if (m) {
          const idx = m[1];
          const name = entry[`deviceName${idx}`];
          const ip = entry[`deviceIP${idx}`];
          if (name && ip) list.push({ name, ip });
        }
      });
      rooms.push({ room, devices: list });
    }
    return rooms;
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "mmm-mystrom";

    const container = document.createElement("div");
    container.className = "mmm-mystrom-wrapper";

    if (this.config.showTitle) {
      const title = document.createElement("div");
      title.className = "mmm-mystrom-title";
      title.innerText = this.config.titleText || "myStrom";
      container.appendChild(title);
    }

    if (!this.rooms || this.rooms.length === 0) {
      const noCfg = document.createElement("div");
      noCfg.className = "mmm-mystrom-info";
      noCfg.innerText = this.translate("NO_DEVICES_CONFIGURED");
      container.appendChild(noCfg);
      wrapper.appendChild(container);
      return wrapper;
    }

    // Build UI per layout
    if (this.config.layout === "inline") {
      container.appendChild(this.renderInline());
    } else {
      container.appendChild(this.renderColumn());
    }

    // Light mode
    if (this.config.displayMode === "light") {
      container.classList.add("mmm-mystrom-light");
    }

    wrapper.appendChild(container);
    return wrapper;
  },

  renderColumn() {
    const container = document.createElement("div");
    container.className = "mmm-mystrom-column";
    if (this.config.showRoomSideBySide) container.classList.add("flex");

    for (const room of this.rooms) {
      const roomEl = document.createElement("div");
      roomEl.className = "mmm-mystrom-room";

      const roomTitle = document.createElement("div");
      roomTitle.className = "mmm-mystrom-room-title";
      if (this.config.displayMode !== "light") {
        roomTitle.innerText = room.room;
      }
      roomEl.appendChild(roomTitle);

      for (const d of room.devices) {
        roomEl.appendChild(this.renderDeviceCard(d));
      }
      container.appendChild(roomEl);
    }
    return container;
  },

  renderInline() {
    const container = document.createElement("div");
    container.className = "mmm-mystrom-inline";

    for (const room of this.rooms) {
      for (const d of room.devices) {
        const card = this.renderDeviceCard(d);
        // add room badge
        const badge = document.createElement("div");
        badge.className = "mmm-mystrom-room-badge";
        if (this.config.displayMode !== "light") {
          badge.innerText = room.room;
        }
        card.prepend(badge);
        container.appendChild(card);
      }
    }

    return container;
  },

  // helper: return normalized hex (like "#RRGGBB" or "#RRGGBBAA") or null if invalid
  normalizeHex(h) {
    if (h === null || typeof h === "undefined") return null;
    let s = String(h).trim();

    // Keep only hex digits and '#' to remove stray characters (e.g., encoding artefacts)
    s = s.replace(/[^0-9A-Fa-f#]/g, "");
    if (!s) return null;

    if (!s.startsWith("#")) s = "#" + s;

    // Expand 3-digit hex (#abc -> #aabbcc)
    if (/^#[0-9A-Fa-f]{3}$/.test(s)) {
      const a = s[1], b = s[2], c = s[3];
      s = `#${a}${a}${b}${b}${c}${c}`;
    }

    // Accept 6 or 8 digits after '#'
    if (!/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(s)) return null;

    return s.toUpperCase();
  },

  formatError(state) {
    let msg = this.translate("ERROR_PREFIX") + ": " + this.translate(state.error);
    if (state.errorDetail) msg += ` (${state.errorDetail})`;
    return msg;
  },

  getColorHex(state) {
    if (!state || !state.values) return null;

    const rows = this.formatValues(state.type, state.values);
    const colorRow = rows.find(r => typeof r === "object" && r.type === "color");
    if (!colorRow) return null;

    return colorRow.hex || null;
  },

  // Replace your existing renderDeviceCard with this (inside Module.register)
  renderDeviceCard(dev) {
    const ip = dev.ip;
    const state = this.dataByIP[ip] || {};

    const card = document.createElement("div");
    card.className = "mmm-mystrom-device";

    // Determine "on" state: switch uses relay, bulb uses on
    const isOn = (state && state.values)
      ? ((state.type === "SWITCH" && state.values.relay) || (state.type === "BULB" && state.values.on) || (state.type === "PIR" && state.values.motion))
      : false;

    if (isOn) {
      card.classList.add("mmm-mystrom-device-on");
    } else {
      card.classList.remove("mmm-mystrom-device-on");
    }

    const name = document.createElement("div");
    name.className = "mmm-mystrom-device-name";

    // === LIGHT MODE ===
    if (this.config.displayMode === "light") {
      card.classList.add("mmm-mystrom-light");

      // TOP-RIGHT (temperature or color)
      const topRight = document.createElement("div");
      topRight.className = "mmm-mystrom-light-top";

      if (state.values) {
        // 1) Temperature
        if (typeof state.values.temperature !== "undefined") {
          topRight.textContent = state.values.temperature + " ° C";
        }
        // 2) Color
        if (typeof state.values.color !== "undefined") {
          const hex = this.getColorHex(state); // use formatted hex

          const sw = document.createElement("span");
          sw.style.display = "inline-block";
          sw.style.width = "0.85em";
          sw.style.height = "0.85em";
          sw.style.marginLeft = "6px";
          sw.style.verticalAlign = "middle";
          sw.style.borderRadius = "3px";

          if (hex) {
            sw.style.backgroundColor = hex;
            sw.title = hex;
            sw.style.border = "1px solid rgba(0,0,0,0.12)";
          } else {
            sw.style.backgroundColor = "transparent";
            sw.style.border = "1px dashed #ccc";
            sw.title = this.translate("N_A");
          }

          topRight.innerHTML = ""; // remove temperature text if needed
          topRight.appendChild(sw);
        }
      }

      card.appendChild(topRight);

      // MIDDLE-CENTER (icon)
      if (!state.error && state.values) {
        const icon = document.createElement("img");
        icon.className = "mmm-mystrom-light-icon";
        icon.src = this.file(`icons/${this.getDeviceIcon(state.type)}`);
        card.appendChild(icon);
      }

      // Middle (power)
      if (state.values && isOn) {
        const middle = document.createElement("div");
        middle.className = "mmm-mystrom-light-middle";

        // Power
        if (typeof state.values.power !== "undefined") {
          middle.textContent = state.values.power + " W";
        }

        // Motion (PIR only)
        if (typeof state.values.motion === "boolean") {
          middle.textContent = this.translate("MOTION");
        }

        card.appendChild(middle);
      }

      if (!state.values && !state.error) {
        const sp = document.createElement("div");
        sp.className = "mmm-mystrom-info";
        sp.innerText = this.translate("LOADING");
        card.appendChild(sp);
      }

      if (state.error) {
        const err = document.createElement("div");
        err.className = "mmm-mystrom-error";
        err.innerText = this.formatError(state);
        card.appendChild(err);
      }

      // BOTTOM-CENTER (device name)
      const bottom = document.createElement("div");
      bottom.className = "mmm-mystrom-light-name";
      bottom.innerText = dev.name || ip;
      card.appendChild(bottom);

      return card;
    } else {
      // Icon injection
      if (!state.error && state.values) {
        const icon = document.createElement("img");
        icon.className = "mmm-mystrom-icon";
        icon.src = this.file(`icons/${this.getDeviceIcon(state.type)}`);
        name.appendChild(icon);
      }

      // Device name text
      name.appendChild(document.createTextNode(dev.name || ip));
      card.appendChild(name);

      if (state.error) {
        const err = document.createElement("div");
        err.className = "mmm-mystrom-error";
        err.innerText = this.formatError(state);
        card.appendChild(err);
        return card;
      }

      if (!state.values) {
        const sp = document.createElement("div");
        sp.className = "mmm-mystrom-info";
        sp.innerText = this.translate("LOADING");
        card.appendChild(sp);
        return card;
      }

      // Values list
      const list = document.createElement("ul");
      list.className = "mmm-mystrom-values";

      const rows = this.formatValues(state.type, state.values);

      for (const row of rows) {
        const li = document.createElement("li");

        if (typeof row === "string") {
          li.innerText = row;
        } else {
          // Structured entry (color or other structured items)
          const displayValue = (row.value ?? row.raw ?? row.hex ?? this.translate("N_A"));
          li.innerText = `${row.label}: ${displayValue}`;

          // render color swatch if raw or hex present
          if (row.hex || row.raw) {
            const hex = this.normalizeHex(row.hex || row.raw);
            const sw = document.createElement("span");
            sw.style.display = "inline-block";
            sw.style.width = "0.85em";
            sw.style.height = "0.85em";
            sw.style.marginLeft = "6px";
            sw.style.verticalAlign = "middle";
            sw.style.borderRadius = "3px";

            if (hex) {
              sw.style.backgroundColor = hex;
              sw.title = hex;
              sw.setAttribute("aria-label", `color ${hex}`);
              sw.style.border = "1px solid rgba(0,0,0,0.12)";
            } else {
              sw.style.backgroundColor = "transparent";
              sw.style.border = "1px dashed #ccc";
              sw.title = row.raw ? String(row.raw) : this.translate("N_A");
              sw.setAttribute("aria-label", "color unavailable");
            }

            li.appendChild(sw);
          }
        }

        list.appendChild(li);
      }

      card.appendChild(list);
      return card;
    }
  },

  formatValues(type, values) {
    const fmt = [];
    const t = k => this.translate(k);

    if (type === "PIR") {
      // motion (boolean), light (number), temperature (number)
      if (typeof values.motion === "boolean") {
        fmt.push(t("MOTION") + ": " + (values.motion ? t("YES") : t("NO")));
      } else {
        fmt.push(t("MOTION") + ": " + t("N_A"));
      }
      if (typeof values.light !== "undefined") {
        fmt.push(t("LIGHT") + ": " + values.light + " lx");
      } else {
        fmt.push(t("LIGHT") + ": " + t("N_A"));
      }
      if (typeof values.temperature !== "undefined") {
        fmt.push(t("TEMPERATURE") + ": " + values.temperature + " °C");
      } else {
        fmt.push(t("TEMPERATURE") + ": " + t("N_A"));
      }
    } else if (type === "SWITCH") {
      if (typeof values.relay === "boolean") {
        fmt.push(t("RELAY") + ": " + (values.relay ? t("ON") : t("OFF")));
      } else {
        fmt.push(t("RELAY") + ": " + t("N_A"));
      }
      if (typeof values.power !== "undefined") {
        fmt.push(t("POWER") + ": " + values.power + " W");
      } else {
        fmt.push(t("POWER") + ": " + t("N_A"));
      }
      if (typeof values.temperature !== "undefined") {
        fmt.push(t("TEMPERATURE") + ": " + values.temperature + " °C");
      } else {
        fmt.push(t("TEMPERATURE") + ": " + t("N_A"));
      }
    } else if (type === "BULB") {
      // ON / OFF
      fmt.push(this.translate("ON_STATE") + ": " + (values.on ? this.translate("ON") : this.translate("OFF")));

      // POWER
      if (typeof values.power !== "undefined") {
        fmt.push(this.translate("POWER") + ": " + values.power + " W");
      } else {
        fmt.push(this.translate("POWER") + ": " + this.translate("N_A"));
      }

      // COLOR (always push a structured object)
      const raw = (values && typeof values.color !== "undefined") ? values.color : null;
      const hex = (values && values.colorHex) ? values.colorHex : null;

      fmt.push({
        type: "color",
        label: this.translate("COLOR"),
        raw: raw,
        hex: hex,
        value: ""
      });
    }

    return fmt;
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "MMM_MYStrom_DATA") {
      // payload: { ip, type, values, ts, error, name, room }
      this.dataByIP[payload.ip] = payload;
      this.processAlert(payload);
      this.updateDom(0);
    } else if (notification === "MMM_MYStrom_BULK") {
      // payload: array of the above
      for (const itm of payload) {
        this.dataByIP[itm.ip] = itm;
        this.processAlert(itm);
      }
      this.updateDom(0);
    }
  },

  processAlert(state) {
    if (!this.config.alertEnabled || !state || !state.values) return;

    const ip = state.ip;
    const dev = this.findDeviceByIP(ip);
    if (!dev) return;

    //
    // Resolve settings per device
    //
    const alertOffOn
      = typeof dev.alertOffOn === "boolean" ? dev.alertOffOn : this.config.defaultAlertOffOn;

    const alertOnOff
      = typeof dev.alertOnOff === "boolean" ? dev.alertOnOff : this.config.defaultAlertOnOff;

    const alertPower
      = typeof dev.alertPower === "boolean" ? dev.alertPower : this.config.defaultAlertPower;

    const alertPowerNormal
      = typeof dev.alertPowerNormal === "boolean" ? dev.alertPowerNormal : this.config.defaultAlertPowerNormal;

    const alertMotionClear
      = typeof dev.alertMotionClear === "boolean" ? dev.alertMotionClear : this.config.defaultAlertMotionClear;

    //
    // Determine ON/OFF state
    //
    const isOn = Boolean(
      (state.type === "SWITCH" && state.values.relay)
      || (state.type === "BULB" && state.values.on)
      || (state.type === "PIR" && state.values.motion),
    );

    const prev = this.lastAlertStates[ip];
    this.lastAlertStates[ip] = isOn;

    // First reading after start: only remember the state, no alert
    if (prev !== undefined) {
      // 🔔 ON → OFF alert
      if (alertOnOff && prev && !isOn) {
        this.triggerAlert(dev, state, "ONOFF");
      }

      // 🔔 OFF → ON alert
      if (alertOffOn && !prev && isOn) {
        this.triggerAlert(dev, state, "OFFON");
      }
    }

    //
    // ⚡ POWER ALERT LOGIC
    //
    if (alertPower || alertPowerNormal) {
      const threshold
        = dev.powerThreshold
          ?? this.config.powerThresholds?.[state.type]
          ?? null;

      const power = Number(state.values.power);

      if (threshold !== null && state.values.power !== undefined && Number.isFinite(power)) {
        const lastExceed = this.lastPowerExceedStates[ip];
        const nowExceed = power >= threshold;
        this.lastPowerExceedStates[ip] = nowExceed;

        if (lastExceed !== undefined) {
          // ⚡ POWER SPIKE ALERT
          if (alertPower && !lastExceed && nowExceed) {
            this.triggerAlert(dev, state, "POWER", { power, threshold });
          }

          // 🔋 POWER NORMAL ALERT
          if (alertPowerNormal && lastExceed && !nowExceed) {
            this.triggerAlert(dev, state, "POWER_NORMAL", { power, threshold });
          }
        }
      }
    }

    //
    // 👋 MOTION CLEAR ALERT (PIR only)
    //
    if (state.type === "PIR" && alertMotionClear) {
      const motion = Boolean(state.values.motion);
      const lastMotion = this.lastMotionState[ip];
      this.lastMotionState[ip] = motion;

      if (lastMotion && !motion) {
        this.triggerAlert(dev, state, "PIR_CLEAR");
      }
    }
  },

  triggerAlert(dev, state, alertType, extra = {}) {
    console.log(`[MMM-myStrom] ${alertType} ALERT:`, state.name || state.ip, extra);

    const payload = {
      ip: state.ip,
      type: state.type,
      name: state.name,
      room: state.room,
      alertFile: this.deviceAlertFile(dev, alertType),
      alertType,
      ...extra,
    };

    if (this.deviceEmailEnabled(dev)) {
      this.sendSocketNotification("MMM_MYStrom_EMAIL_ALERT", payload);
    }
    this.playAlertSound(payload);
  },

  // Device-level sound for one alert type (older option names still work)
  deviceAlertFile(dev, alertType) {
    switch (alertType) {
      case "OFFON": return dev.alertFile || null;
      case "ONOFF": return dev.alertFileOff || dev.alertFilesOff || null;
      case "POWER": return dev.alertFilePower || null;
      case "POWER_NORMAL": return dev.alertFilePowerNormal || null;
      case "PIR_CLEAR": return dev.alertFilePirClear || dev.alertFilesPirClear || null;
      default: return null;
    }
  },

  findDeviceByIP(ip) {
    for (const room of this.rooms) {
      for (const d of room.devices) {
        if (d.ip === ip) return d;
      }
    }
    return null;
  },

  getDeviceIcon(type) {
    switch (type) {
      case "PIR": return "pir.png";
      case "SWITCH": return "switch.png";
      case "BULB": return "bulb.png";
      default: return "questionmark.png";
    }
  },

  playAlertSound(deviceInfo) {
    const type = deviceInfo.type;
    const alertType = deviceInfo.alertType;
    const cfg = this.config;

    // 1. Device-specific sound for this alert type, 2. global sound per device type
    const globalFile = {
      OFFON: cfg.alertFiles?.[type],
      // "alertFileOff" is the name the README used before 1.2.0
      ONOFF: cfg.alertFileOff?.[type] || cfg.alertFilesOff?.[type] || cfg.alertFiles?.[type],
      POWER: cfg.alertFilesPower?.[type],
      POWER_NORMAL: cfg.alertFilesPowerNormal?.[type] || cfg.alertFilesPower?.[type],
      PIR_CLEAR: cfg.alertFilesPirClear?.[type] || cfg.alertFiles?.PIR,
    }[alertType];

    const file = deviceInfo.alertFile || globalFile;
    if (!file) {
      console.warn("[MMM-myStrom] No matching sound for alertType:", alertType, "device type:", type);
      return;
    }

    // Only plain file names from the sounds folder
    const name = String(file).split(/[\\/]/).pop();
    this._playSound(this.file("sounds/" + name));
  },

  _playSound(path) {
    const audio = new Audio(path);
    audio.volume = 1.0;
    audio.play().catch((err) => {
      console.warn("[MMM-myStrom] Audio playback failed:", err);
    });
  },

  deviceEmailEnabled(dev) {
    if (typeof dev.email === "boolean") {
      return dev.email;
    }
    return Boolean(this.config.defaultEmailAlert);
  },

});
