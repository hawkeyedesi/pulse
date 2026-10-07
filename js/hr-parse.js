// Parser for the Bluetooth SIG Heart Rate Measurement characteristic (0x2A37).
//
// Byte 0 = flags
//   bit 0      : HR value format. 0 = UINT8, 1 = UINT16 (little-endian)
//   bits 1..2  : Sensor contact status. bit2 = feature supported, bit1 = contact detected
//   bit 3      : Energy Expended present (UINT16, kilojoules)
//   bit 4      : RR-Interval(s) present (one or more UINT16, units of 1/1024 s)
// Then: HR value, [energy expended], [RR intervals...]

/**
 * @param {DataView|ArrayBuffer|Uint8Array|number[]} input
 * @returns {{hr:number, contactSupported:boolean, contactDetected:(boolean|null),
 *            energyExpended:(number|null), rr:number[], rrRaw:number[], flags:number}}
 */
export function parseHeartRateMeasurement(input) {
  const dv = toDataView(input);
  if (dv.byteLength < 2) throw new RangeError('Heart rate packet too short');
  const flags = dv.getUint8(0);
  const is16 = (flags & 0x01) !== 0;
  const contactSupported = (flags & 0x04) !== 0;
  const contactDetected = contactSupported ? (flags & 0x02) !== 0 : null;
  const energyPresent = (flags & 0x08) !== 0;
  const rrPresent = (flags & 0x10) !== 0;

  let i = 1;
  let hr;
  if (is16) {
    if (dv.byteLength < 3) throw new RangeError('Heart rate packet too short for UINT16 value');
    hr = dv.getUint16(i, true);
    i += 2;
  } else {
    hr = dv.getUint8(i);
    i += 1;
  }

  let energyExpended = null;
  if (energyPresent) {
    if (i + 2 <= dv.byteLength) energyExpended = dv.getUint16(i, true);
    i += 2;
  }

  const rrRaw = [];
  if (rrPresent) {
    while (i + 2 <= dv.byteLength) {
      rrRaw.push(dv.getUint16(i, true));
      i += 2;
    }
  }
  const rr = rrRaw.map((v) => Math.round((v * 1000) / 1024));
  return { hr, contactSupported, contactDetected, energyExpended, rr, rrRaw, flags };
}

/** Battery Level characteristic (0x2A19): single UINT8 percentage. */
export function parseBatteryLevel(input) {
  const dv = toDataView(input);
  if (dv.byteLength < 1) return null;
  return Math.min(100, dv.getUint8(0));
}

function toDataView(input) {
  if (input instanceof DataView) return input;
  if (input instanceof ArrayBuffer) return new DataView(input);
  if (ArrayBuffer.isView(input)) return new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return new DataView(Uint8Array.from(input).buffer);
  throw new TypeError('Unsupported input for heart rate parser');
}

/** Build a 0x2A37 packet (used by demo mode and tests). */
export function encodeHeartRateMeasurement({ hr, rr = [], energy = null, contact = true, force16 = false }) {
  const is16 = force16 || hr > 255;
  let flags = 0;
  if (is16) flags |= 0x01;
  flags |= 0x04; // contact feature supported
  if (contact) flags |= 0x02;
  if (energy != null) flags |= 0x08;
  if (rr.length) flags |= 0x10;
  const bytes = [flags];
  if (is16) bytes.push(hr & 0xff, (hr >> 8) & 0xff);
  else bytes.push(hr & 0xff);
  if (energy != null) bytes.push(energy & 0xff, (energy >> 8) & 0xff);
  for (const ms of rr) {
    const v = Math.round((ms * 1024) / 1000);
    bytes.push(v & 0xff, (v >> 8) & 0xff);
  }
  return new DataView(Uint8Array.from(bytes).buffer);
}
