/* The newer ECMAScript helpers pdf.js 6 calls.
 *
 * pdf.js uses the typed-array hex/base64 helpers and the Map upsert proposal
 * (`getOrInsert`, `getOrInsertComputed`). Chromium 140+ has them; the Chromium
 * inside Electron 37 — which is what the shipped Stratos app runs, and older
 * browsers too — does not, so the viewer failed with "a.toHex is not a
 * function" before a page was ever painted. These spec-shaped polyfills are
 * installed only when the platform is missing them, so a modern browser keeps
 * its native versions.
 *
 * Imported by the page and by the worker wrapper, because pdf.js parses the
 * document in a module worker of its own.
 */

const HEX = /^[0-9a-fA-F]*$/;

function install() {
  const bytes = Uint8Array.prototype;

  if (typeof bytes.toHex !== 'function') {
    Object.defineProperty(bytes, 'toHex', {
      configurable: true,
      writable: true,
      value: function toHex() {
        let out = '';
        for (let i = 0; i < this.length; i++) out += this[i].toString(16).padStart(2, '0');
        return out;
      },
    });
  }

  if (typeof Uint8Array.fromHex !== 'function') {
    Object.defineProperty(Uint8Array, 'fromHex', {
      configurable: true,
      writable: true,
      value: function fromHex(text) {
        const clean = String(text);
        if (clean.length % 2 !== 0) throw new SyntaxError('fromHex expects an even number of digits');
        if (!HEX.test(clean)) throw new SyntaxError('fromHex expects hexadecimal digits only');
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        return out;
      },
    });
  }

  if (typeof bytes.toBase64 !== 'function') {
    Object.defineProperty(bytes, 'toBase64', {
      configurable: true,
      writable: true,
      value: function toBase64() {
        let binary = '';
        for (let i = 0; i < this.length; i++) binary += String.fromCharCode(this[i]);
        return btoa(binary);
      },
    });
  }

  if (typeof Uint8Array.fromBase64 !== 'function') {
    Object.defineProperty(Uint8Array, 'fromBase64', {
      configurable: true,
      writable: true,
      value: function fromBase64(text) {
        const binary = atob(String(text).replace(/\s+/g, ''));
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
      },
    });
  }

  // pdf.js 6 also uses the Map upsert proposal, which Chromium 140+ ships.
  for (const Type of [Map, WeakMap]) {
    if (typeof Type.prototype.getOrInsert !== 'function') {
      Object.defineProperty(Type.prototype, 'getOrInsert', {
        configurable: true,
        writable: true,
        value: function getOrInsert(key, value) {
          if (this.has(key)) return this.get(key);
          this.set(key, value);
          return value;
        },
      });
    }
    if (typeof Type.prototype.getOrInsertComputed !== 'function') {
      Object.defineProperty(Type.prototype, 'getOrInsertComputed', {
        configurable: true,
        writable: true,
        value: function getOrInsertComputed(key, callback) {
          if (this.has(key)) return this.get(key);
          if (typeof callback !== 'function') throw new TypeError('getOrInsertComputed needs a callback');
          const value = callback(key);
          this.set(key, value);
          return value;
        },
      });
    }
  }
}

install();
