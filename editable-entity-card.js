/*
 * Editable Entity Card
 * A Mushroom-style entity card whose value is editable in place, no pop-up.
 * Made for input_text / text / input_number / number entities, e.g. color
 * settings: the circle takes the color of the value when it is a color.
 */
const TAG = "editable-entity-card";
const EDITOR_TAG = "editable-entity-card-editor";
const CARD_VERSION = "0.1.0-beta";

const UNAVAILABLE = ["unavailable", "unknown"];
const TEXT_DOMAINS = ["input_text", "text"];
const NUMBER_DOMAINS = ["input_number", "number"];

// Accepts "#rgb", "#rrggbb", "r,g,b", "rgb(r,g,b)" or [r,g,b] -> "r,g,b"
const toRgb = (c) => {
  if (Array.isArray(c) && c.length === 3 && c.every((n) => Number.isFinite(Number(n)))) return c.map((n) => Math.round(Number(n))).join(",");
  if (typeof c !== "string") return null;
  const s = c.trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(",");
  }
  const m = s.match(/^(?:rgb\()?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)?$/i);
  return m ? `${m[1]},${m[2]},${m[3]}` : null;
};
// white icon like your current card, dark only on near-white colors
const iconColorFor = (rgb) => {
  const [r, g, b] = rgb.split(",").map(Number);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.88 ? "#1c1c1c" : "#ffffff";
};

class EditableEntityCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          position: relative; overflow: hidden; box-sizing: border-box; border: none; min-height: 68px;
          display: flex; align-items: center;
        }
        .tile {
          position: absolute; left: -9px; top: -7.5px; width: 65px; height: 65px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center; --mdc-icon-size: 44px;
          background: var(--primary-color); color: #fff; transition: background .3s, color .3s;
        }
        .tile ha-icon { display: flex; }
        .info { flex: 1; min-width: 0; padding: 8px 12px 8px 64px; }
        .name {
          font-size: 14px; font-weight: 500; line-height: 1.5; color: var(--primary-text-color);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .val {
          display: block; box-sizing: border-box; width: 100%; margin: 0; padding: 0; border: 0; border-radius: 0; outline: none;
          background: none; appearance: none; -webkit-appearance: none; font: inherit; font-size: 12px; font-weight: 400; line-height: 1.5;
          color: var(--secondary-text-color); text-overflow: ellipsis; cursor: text;
          /* iOS: make sure the field stays editable */
          -webkit-user-select: text; user-select: text;
          border-bottom: 1px solid transparent; transition: color .2s, border-color .2s;
        }
        .val::placeholder { color: var(--secondary-text-color); opacity: .6; }
        .val:not(:disabled):hover { border-bottom-color: color-mix(in srgb, var(--secondary-text-color) 45%, transparent); }
        .val:focus { color: var(--primary-text-color); border-bottom-color: var(--primary-color); }
        .val.invalid, .val.invalid:focus { border-bottom-color: var(--error-color, #db4437); }
        .val:disabled { cursor: default; }
      </style>
      <ha-card>
        <div class="tile"><ha-icon></ha-icon></div>
        <div class="info">
          <div class="name"></div>
          <input class="val" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" enterkeyhint="done" />
        </div>
      </ha-card>`;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._tile = $(".tile");
    this._icon = $(".tile ha-icon");
    this._name = $(".name");
    this._input = $(".val");
    this._editing = false;

    this._input.addEventListener("focus", () => { this._editing = true; });
    this._input.addEventListener("blur", () => { this._editing = false; this._input.classList.remove("invalid"); this._sync(); });
    this._input.addEventListener("input", () => this._input.classList.toggle("invalid", !this._valid(this._input.value)));
    this._input.addEventListener("change", () => this._commit());
    // keep Home Assistant's global keyboard shortcuts out of the field
    this._input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); this._input.blur(); }
      else if (e.key === "Escape") { this._reverting = true; this._input.value = this._state()?.state ?? ""; this._input.blur(); this._reverting = false; }
    });
  }

  // ---------- HA integration ----------
  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig(hass, entities, entitiesFallback) {
    const ok = (id) => typeof id === "string" && (TEXT_DOMAINS.concat(NUMBER_DOMAINS)).some((d) => id.startsWith(d + "."));
    const e = (entities || []).find(ok) || (entitiesFallback || []).find(ok) || Object.keys(hass?.states || {}).find(ok);
    return { entity: e || "input_text.example" };
  }

  setConfig(config) {
    if (!config || !config.entity) throw new Error("You need to define an entity");
    this._config = { color_from_value: true, ...config };
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() { return 1; }
  getGridOptions() { return { columns: 12, min_columns: 3 }; }

  // ---------- helpers ----------
  _state() { return this._hass?.states?.[this._config.entity]; }
  _domain() { return String(this._config.entity).split(".")[0]; }

  _valid(v) {
    const st = this._state();
    const a = st?.attributes || {};
    if (NUMBER_DOMAINS.includes(this._domain())) {
      if (v.trim() === "" || isNaN(Number(v))) return false;
      const n = Number(v);
      return !((a.min != null && n < Number(a.min)) || (a.max != null && n > Number(a.max)));
    }
    if (a.min != null && v.length < Number(a.min)) return false;
    if (a.max != null && v.length > Number(a.max)) return false;
    if (a.pattern) {
      try { return new RegExp(`^(?:${a.pattern})$`).test(v); } catch (e) { return true; }
    }
    return true;
  }

  _commit() {
    if (this._reverting) return;
    const st = this._state();
    if (!st) return;
    const v = this._input.value;
    if (v === st.state) return;
    if (!this._valid(v)) { this._input.classList.add("invalid"); return; }
    const domain = this._domain();
    const value = NUMBER_DOMAINS.includes(domain) ? Number(v) : v;
    this._hass.callService(domain, "set_value", { entity_id: this._config.entity, value });
    // if Home Assistant rejects it the state never changes: show the real value again
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this._sync(), 3000);
  }

  // show the entity's value in the field unless the user is typing
  _sync() {
    const st = this._state();
    if (!st || this._editing) return;
    const v = UNAVAILABLE.includes(st.state) ? "" : st.state;
    if (this._input.value !== v) this._input.value = v;
  }

  // ---------- render ----------
  _render() {
    if (!this._config || !this._hass) return;
    const cfg = this._config;
    const st = this._state();
    if (!st) {
      this._name.textContent = cfg.name || cfg.entity;
      this._input.value = "Entity not found";
      this._input.disabled = true;
      return;
    }
    const a = st.attributes || {};
    const unavailable = UNAVAILABLE.includes(st.state);
    this._name.textContent = cfg.name ?? a.friendly_name ?? cfg.entity;
    this._icon.setAttribute("icon", cfg.icon || a.icon || "mdi:form-textbox");

    // circle color: the value when it is a color, else `color`, else the theme color
    const fromValue = cfg.color_from_value !== false && !unavailable ? toRgb(st.state) : null;
    const rgb = fromValue || toRgb(cfg.color);
    this._tile.style.background = rgb ? `rgb(${rgb})` : "var(--primary-color)";
    this._tile.style.color = rgb ? iconColorFor(rgb) : "#fff";
    this._tile.style.opacity = unavailable ? ".5" : "1";

    this._input.disabled = unavailable;
    this._input.placeholder = unavailable ? st.state : cfg.placeholder || "";
    const a2 = st.attributes || {};
    if (a2.max != null && TEXT_DOMAINS.includes(this._domain())) this._input.maxLength = Number(a2.max);
    else this._input.removeAttribute("maxlength");
    this._input.inputMode = NUMBER_DOMAINS.includes(this._domain()) ? "decimal" : "text";
    this._sync();
  }
}

// ---------- Visual editor ----------
const EDITOR_LABELS = {
  entity: "Entity (input_text, text, input_number or number)",
  name: "Name",
  icon: "Icon",
  color_from_value: "Use the value as the circle color when it is a color",
  color: "Circle color when the value is not a color (e.g. #2196f3)",
  placeholder: "Placeholder text",
};
const EDITOR_DEFAULTS = { color_from_value: true };
const EDITOR_SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: ["input_text", "text", "input_number", "number"] } } },
  { name: "name", selector: { text: {} } },
  { name: "icon", selector: { icon: {} } },
  { name: "color_from_value", selector: { boolean: {} } },
  { name: "color", selector: { text: {} } },
  { name: "placeholder", selector: { text: {} } },
];

class EditableEntityCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._sync();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    else this._sync();
  }

  _sync() {
    if (!this._config || !this._hass) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.schema = EDITOR_SCHEMA;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const config = { ...this._config, ...ev.detail.value };
        for (const [k, v] of Object.entries(EDITOR_DEFAULTS)) if (config[k] === v) delete config[k];
        for (const k of Object.keys(config)) if (config[k] === "" || config[k] == null) delete config[k];
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = { ...EDITOR_DEFAULTS, ...this._config };
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, EditableEntityCard);
if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, EditableEntityCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === TAG)) {
  window.customCards.push({
    type: TAG,
    name: "Editable Entity Card",
    description: "Mushroom-style entity card with a value you can edit in place. For input_text, text, input_number and number entities.",
    preview: true,
  });
}
console.info(`%c EDITABLE-ENTITY-CARD %c v${CARD_VERSION} `, "color:white;background:#FFC107;font-weight:700", "color:#FFC107;background:white");
