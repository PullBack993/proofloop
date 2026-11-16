// Loaded into the app under test with `node --import`. Freezes Date at PROOFLOOP_FIXED_TIME so
// timestamps in responses are identical between baseline and verify runs. Timers are untouched.
const fixed = Date.parse(process.env.PROOFLOOP_FIXED_TIME ?? '');
if (!Number.isNaN(fixed)) {
  const RealDate = Date;
  const FixedDate = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [fixed], newTarget);
    },
    apply() {
      return new RealDate(fixed).toString();
    },
    get(target, prop, receiver) {
      if (prop === 'now') return () => fixed;
      return Reflect.get(target, prop, receiver);
    },
  });
  globalThis.Date = FixedDate;
}
export {};
