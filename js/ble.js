// Web Bluetooth heart-rate strap (Polar H10 / H9 or any standard BLE HR sensor)
// plus a simulated strap for demo mode. Both emit the same events:
//   'status'  detail: { state: 'idle'|'searching'|'connecting'|'connected'|'reconnecting'|'disconnected'|'error', message?, device? }
//   'hr'      detail: { t, hr, rr:[ms], energy, contact }
//   'battery' detail: { level }

import { parseHeartRateMeasurement, parseBatteryLevel, encodeHeartRateMeasurement } from './hr-parse.js';

const HR_SERVICE = 'heart_rate';
const HR_MEASUREMENT = 'heart_rate_measurement'; // 0x2A37
const BATTERY_SERVICE = 'battery_service';
const BATTERY_LEVEL = 'battery_level'; // 0x2A19
const REMEMBER_KEY = 'pulse.strap';

export function rememberedStrap() {
  try { return JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null'); } catch { return null; }
}
export function touchRememberedStrap(patch) {
  const cur = rememberedStrap() || {};
  localStorage.setItem(REMEMBER_KEY, JSON.stringify({ ...cur, ...patch }));
}

export function bluetoothSupport() {
  const bt = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined;
  return {
    available: !!bt && typeof bt.requestDevice === 'function',
    getDevices: !!bt && typeof bt.getDevices === 'function',
    secure: typeof window !== 'undefined' ? window.isSecureContext : true,
  };
}

function withTimeout(p, ms, msg) {
  let to;
  return Promise.race([p, new Promise((_, rej) => { to = setTimeout(() => rej(new Error(msg || 'timeout')), ms); })])
    .finally(() => clearTimeout(to));
}

export class BleStrap extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.hrChar = null;
    this.batteryChar = null;
    this.state = 'idle';
    this.keepAlive = false; // true while a workout wants the connection
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.batteryTimer = null;
    this._onDisconnected = this._onDisconnected.bind(this);
    this._onHr = this._onHr.bind(this);
    this._onBattery = this._onBattery.bind(this);
  }

  get name() { return this.device?.name || 'Heart-rate strap'; }

  _status(state, extra = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, device: this.device?.name, ...extra } }));
  }

  /**
   * Try to reconnect to the remembered strap without a picker.
   * Resolves true on success, false when not possible (caller shows picker button).
   */
  async connectSilently(timeoutMs = 9000) {
    const support = bluetoothSupport();
    const mem = rememberedStrap();
    if (!support.getDevices || !mem?.id) return false;
    this._status('searching', { message: `Looking for ${mem.name || 'your strap'}…` });
    try {
      const devices = await navigator.bluetooth.getDevices();
      const dev = devices.find((d) => d.id === mem.id) || devices.find((d) => mem.name && d.name === mem.name);
      if (!dev) return false;
      this._attach(dev);
      // Some Chrome builds need advertisements seen before connecting to a known device.
      if (typeof dev.watchAdvertisements === 'function') {
        try {
          const ac = new AbortController();
          const seen = new Promise((res) => dev.addEventListener('advertisementreceived', res, { once: true }));
          await dev.watchAdvertisements({ signal: ac.signal });
          await withTimeout(seen, 4000).catch(() => {});
          ac.abort();
        } catch { /* not supported; just try to connect */ }
      }
      await withTimeout(this._connectGatt(), timeoutMs, 'Strap not found');
      return true;
    } catch (err) {
      console.warn('Silent reconnect failed', err);
      this._status('idle', { message: 'Strap not found automatically' });
      return false;
    }
  }

  /**
   * Show the browser's Bluetooth picker. MUST be called synchronously from a tap/click
   * handler: requestDevice() is invoked before the first await.
   */
  connectWithPicker() {
    if (!bluetoothSupport().available) return Promise.reject(new Error('Web Bluetooth is not available in this browser'));
    const req = navigator.bluetooth.requestDevice({
      filters: [{ services: [HR_SERVICE] }],
      optionalServices: [BATTERY_SERVICE],
    });
    this._status('searching', { message: 'Choose your strap…' });
    return (async () => {
      const dev = await req;
      this._attach(dev);
      await this._connectGatt();
      return true;
    })().catch((err) => {
      const cancelled = err && (err.name === 'NotFoundError' || /cancel/i.test(err.message));
      this._status(cancelled ? 'idle' : 'error', { message: cancelled ? 'No strap chosen' : err.message });
      throw err;
    });
  }

  _attach(dev) {
    if (this.device && this.device !== dev) this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
    this.device = dev;
    dev.removeEventListener('gattserverdisconnected', this._onDisconnected);
    dev.addEventListener('gattserverdisconnected', this._onDisconnected);
  }

  async _connectGatt() {
    this._status('connecting', { message: `Connecting to ${this.name}…` });
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(HR_SERVICE);
    this.hrChar = await service.getCharacteristic(HR_MEASUREMENT);
    this.hrChar.removeEventListener('characteristicvaluechanged', this._onHr);
    this.hrChar.addEventListener('characteristicvaluechanged', this._onHr);
    await this.hrChar.startNotifications();
    touchRememberedStrap({ id: this.device.id, name: this.device.name || 'Heart-rate strap', lastSeen: Date.now() });
    this.retryAttempt = 0;
    this._status('connected', { message: `Connected to ${this.name}` });
    this._setupBattery(server).catch((e) => console.info('Battery service unavailable', e?.message));
  }

  async _setupBattery(server) {
    const bs = await server.getPrimaryService(BATTERY_SERVICE);
    this.batteryChar = await bs.getCharacteristic(BATTERY_LEVEL);
    const read = async () => {
      try {
        const v = await this.batteryChar.readValue();
        this._emitBattery(parseBatteryLevel(v));
      } catch { /* ignore */ }
    };
    await read();
    try {
      this.batteryChar.addEventListener('characteristicvaluechanged', this._onBattery);
      await this.batteryChar.startNotifications();
    } catch { /* many straps don't notify battery */ }
    clearInterval(this.batteryTimer);
    this.batteryTimer = setInterval(read, 5 * 60 * 1000);
  }

  _onBattery(ev) { this._emitBattery(parseBatteryLevel(ev.target.value)); }
  _emitBattery(level) {
    if (level == null) return;
    touchRememberedStrap({ battery: level });
    this.dispatchEvent(new CustomEvent('battery', { detail: { level } }));
  }

  _onHr(ev) {
    try {
      const m = parseHeartRateMeasurement(ev.target.value);
      this.dispatchEvent(new CustomEvent('hr', {
        detail: { t: Date.now(), hr: m.hr, rr: m.rr, energy: m.energyExpended, contact: m.contactDetected },
      }));
    } catch (e) { console.warn('Bad HR packet', e); }
  }

  _onDisconnected() {
    clearInterval(this.batteryTimer);
    if (!this.keepAlive) { this._status('disconnected', { message: 'Strap disconnected' }); return; }
    this._scheduleRetry();
  }

  _scheduleRetry() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(30000, 1000 * 2 ** this.retryAttempt); // 1,2,4,8,16,30,30…
    this.retryAttempt++;
    this._status('reconnecting', { message: `Reconnecting… (attempt ${this.retryAttempt})`, delay });
    this.retryTimer = setTimeout(async () => {
      if (!this.keepAlive || !this.device) return;
      try {
        await withTimeout(this._connectGatt(), 10000, 'reconnect timeout');
      } catch (e) {
        console.warn('Reconnect failed', e?.message);
        if (this.keepAlive) this._scheduleRetry();
      }
    }, delay);
  }

  async disconnect() {
    this.keepAlive = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.batteryTimer);
    try { await this.hrChar?.stopNotifications(); } catch { /* ignore */ }
    try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch { /* ignore */ }
    this._status('disconnected', { message: 'Disconnected' });
  }
}

/** Simulated strap: realistic-ish HR drifting with "sets" and rests, RR intervals, battery. */
export class DemoStrap extends EventTarget {
  constructor() {
    super();
    this.state = 'idle';
    this.keepAlive = false;
    this.timer = null;
    this.hr = 92;
    this.t0 = 0;
    this.dropUntil = 0;
    this.device = { name: 'Demo strap', id: 'demo' };
  }
  get name() { return 'Demo strap'; }
  _status(state, extra = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, device: this.name, ...extra } }));
  }
  async connectSilently() { return this._connect(); }
  connectWithPicker() { return this._connect(); }
  async _connect() {
    this._status('searching', { message: 'Looking for demo strap…' });
    await sleep(500);
    this._status('connecting', { message: 'Connecting to Demo strap…' });
    await sleep(500);
    this._status('connected', { message: 'Connected to Demo strap' });
    this.dispatchEvent(new CustomEvent('battery', { detail: { level: 82 } }));
    this.t0 = Date.now();
    clearInterval(this.timer);
    this.timer = setInterval(() => this._tick(), 1000);
    setTimeout(() => this._tick(), 250);
    return true;
  }
  _tick() {
    const now = Date.now();
    if (now < this.dropUntil) return;
    if (this.state === 'reconnecting') this._status('connected', { message: 'Reconnected to Demo strap' });
    const s = (now - this.t0) / 1000;
    // 40 s work / 20 s rest pattern on top of a slow warm-up ramp
    const ramp = Math.min(1, s / 90);
    const working = (s % 60) < 40;
    const target = 95 + ramp * (working ? 60 : 30) + 8 * Math.sin(s / 37);
    this.hr += (target - this.hr) * 0.12 + (Math.random() - 0.5) * 2.2;
    const hr = Math.round(this.hr);
    const rrBase = 60000 / hr;
    const rr = [Math.round(rrBase + (Math.random() - 0.5) * 30)];
    // round-trip through the real parser so demo mode exercises it
    const packet = encodeHeartRateMeasurement({ hr, rr, contact: true });
    const fakeEvent = { target: { value: packet } };
    BleStrap.prototype._onHr.call(this, fakeEvent);
  }
  /** Demo-only: simulate the strap dropping out for `seconds`. */
  simulateDropout(seconds = 6) {
    this.dropUntil = Date.now() + seconds * 1000;
    if (this.keepAlive) this._status('reconnecting', { message: 'Reconnecting… (attempt 1)' });
  }
  async disconnect() {
    this.keepAlive = false;
    clearInterval(this.timer);
    this._status('disconnected', { message: 'Disconnected' });
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
