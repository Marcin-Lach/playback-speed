// The playback-rate range, defined once and shared by the popup and the content script.
//
// Both of them have to clamp incoming values, and the slider has to agree with them
// about its own bounds, so keeping three copies of these numbers in sync by hand was
// how the slider ended up able to display a rate its thumb could not represent.
//
// This is a classic script rather than an ES module because Manifest V3 content scripts
// cannot be modules. It assigns to globalThis instead of declaring top-level bindings so
// that injecting it more than once — which popup.js does on every open — cannot fail with
// a redeclaration error.
(() => {
  const MIN_RATE = 0.1;
  const MAX_RATE = 4.0;
  const DEFAULT_RATE = 1.0;

  // Every preset must be a whole number of steps above MIN_RATE, or the browser snaps
  // the slider thumb to a different value than the one being displayed and stored.
  // configureSlider() in popup.js warns if a preset ever violates that.
  const RATE_STEP = 0.05;

  /**
   * Coerces a stored or user-supplied value into a usable rate.
   *
   * Anything that is not a positive finite number falls back to DEFAULT_RATE rather than
   * clamping to MIN_RATE. Coercion turns null, '', false, and [] into 0, so clamping
   * would have answered those with 0.1x — near-frozen playback that reads as a broken
   * extension rather than as a bad setting.
   *
   * The result is rounded to hundredths so the stored value never carries float noise.
   */
  function normalizeRate(value) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      return DEFAULT_RATE;
    }
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) {
      return DEFAULT_RATE;
    }
    const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
    return Math.round(clamped * 100) / 100;
  }

  globalThis.PrimeVideoSpeedRate = {
    MIN_RATE,
    MAX_RATE,
    RATE_STEP,
    DEFAULT_RATE,
    normalizeRate,
  };
})();
