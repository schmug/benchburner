// Injected into the Bitburner page via page.evaluateOnNewDocument BEFORE
// Bitburner's bundle executes. Replaces Math.random with a seeded SFC32
// PRNG and plants the RFA port for the harness hook patch to pick up.
//
// The harness string-replaces __BENCHBURNER_SEED__ and __BENCHBURNER_PORT__
// at inject time with integers from config/run.yaml.
(function () {
  var seed = __BENCHBURNER_SEED__ | 0; // integer cast
  if (!seed) seed = 1;

  // xmur3 hash → seed four 32-bit state words for SFC32.
  function xmur3(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }

  var hasher = xmur3(String(seed));
  var a = hasher(),
    b = hasher(),
    c = hasher(),
    d = hasher();

  function sfc32() {
    var t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  Object.defineProperty(Math, "random", {
    value: sfc32,
    writable: false,
    configurable: false,
  });

  globalThis.__BENCHBURNER_RFA_PORT = __BENCHBURNER_PORT__;
  globalThis.__BENCHBURNER_ACTIVE = true;
})();
