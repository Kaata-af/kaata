// Execute the real transition hook. Native timing/completion is controlled;
// this is not a native rendering or frame-time test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const mobile = path.resolve(__dirname, '../..');
const req = createRequire(path.join(mobile, 'package.json'));
const ts = req('typescript');
const hookFile = path.join(mobile, 'lib/use-home-page-transition.ts');
const fixtureFile = path.join(__dirname, 'ui-fixture.ts');
function compile(filename, requireDependency) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(requireDependency, module, module.exports);
  return module.exports;
}
const { uiHooks } = compile(fixtureFile, req);
let checks = 0;
function fixture(initialDirection = 'collect') {
  const hooks = uiHooks();
  // Shared fixture models effect ordering, not React's native paint boundary.
  const react = { ...hooks.react, useLayoutEffect: hooks.react.useEffect };
  const animations = [];
  const props = { direction: initialDirection, enabled: true, resetKey: 'account-a/vault-a/390/search0' };
  let current = true;
  class Value {
    constructor(value) { this.value = value; }
    setValue(value) { this.value = value; }
  }
  const Animated = {
    Value,
    timing(value, options) {
      assert.equal(options.useNativeDriver, true, 'Slide requests the native driver');
      assert.equal(options.isInteraction, false, 'Presentation does not block interaction scheduling');
      const record = { value, options, stopped: false, callback: null };
      animations.push(record);
      return {
        start(callback) { record.callback = callback; },
        stop() {
          record.stopped = true;
          record.callback?.({ finished: false });
        },
      };
    },
  };
  const { useHomePageTransition } = compile(hookFile, (name) => {
    if (name === 'react') return react;
    if (name === 'react-native') return { Animated };
    assert.fail('Unexpected hook dependency: ' + name);
  });
  const render = () => hooks.render(() => useHomePageTransition(
    props.direction, props.enabled, props.resetKey, () => current));
  const update = (changes) => { Object.assign(props, changes); return render(); };
  const complete = (record, finished = true) => {
    assert.equal(typeof record.callback, 'function', 'Animation actually started');
    if (finished && !record.stopped) record.value.setValue(record.options.toValue);
    // Deliberately deliver stale callbacks even after stop/unmount.
    record.callback({ finished });
  };
  const finish = (record, finished = true) => { complete(record, finished); return render(); };
  const assertResting = (direction) => {
    assert.equal(hooks.tree.renderedDirection, direction);
    assert.equal(hooks.tree.switching, false);
    assert.equal(hooks.tree.translateX.value, 0, 'Resting page is visibly at zero');
    checks++;
  };
  render();
  return { hooks, props, animations, render, update, complete, finish, assertResting,
    setCurrent(value) { current = value; }, get state() { return hooks.tree; } };
}
for (const initial of ['collect', 'pay']) {
  const f = fixture(initial);
  f.assertResting(initial);
  assert.equal(f.animations.length, 0, 'Initial page needs no native animation to become visible');
  for (let i = 0; i < 20; i++) f.render();
  assert.equal(f.animations.length, 0, 'Resting rerenders schedule no idle animations');
  f.hooks.unmount();
}
for (const [from, target, offset] of [['collect', 'pay', -24], ['pay', 'collect', 24]]) {
  const f = fixture(from);
  f.update({ direction: target });
  assert.equal(f.state.renderedDirection, from, 'Destination stays unrendered throughout exit');
  assert.equal(f.state.switching, true);
  assert.equal(f.animations.length, 1);
  const exit = f.animations[0];
  assert.equal(exit.options.toValue, offset);
  assert.equal(exit.options.duration, 100);
  f.complete(exit);
  assert.equal(f.state.renderedDirection, from, 'Delayed React commit still shows the old page');
  assert.equal(f.state.translateX.value, offset, 'Exit completion cannot jump the old page to incoming edge');
  assert.equal(f.animations.length, 1, 'Entry waits for the destination commit');
  f.render();
  assert.equal(f.state.renderedDirection, target, 'Successful current exit commits only the destination');
  assert.equal(f.state.translateX.value, -offset, 'Committed destination starts at the opposite small offset');
  assert.equal(f.state.switching, true, 'Actions stay blocked through entry');
  assert.equal(f.animations.length, 2);
  const enter = f.animations[1];
  assert.equal(enter.options.toValue, 0);
  assert.equal(enter.options.duration, 160);
  f.finish(enter);
  f.assertResting(target);
  const count = f.animations.length;
  f.render(); f.render();
  assert.equal(f.animations.length, count, 'Completed transition schedules no more animation');
  f.hooks.unmount();
}
{
  const f = fixture();
  f.update({ direction: 'pay' });
  const oldExit = f.animations[0];
  f.update({ direction: 'collect' });
  assert.ok(oldExit.stopped, 'Reversal before exit stops the old animation');
  f.assertResting('collect');
  f.finish(oldExit);
  f.assertResting('collect');
  f.update({ direction: 'pay' });
  const latestExit = f.animations.at(-1);
  f.finish(oldExit);
  assert.equal(f.state.renderedDirection, 'collect', 'Old completion cannot satisfy a new matching target');
  f.finish(latestExit);
  f.finish(f.animations.at(-1));
  f.assertResting('pay');
  f.hooks.unmount();
}
{
  const f = fixture();
  f.update({ direction: 'pay' });
  f.finish(f.animations[0]);
  const oldEnter = f.animations[1];
  f.update({ direction: 'collect' });
  const newExit = f.animations[2];
  f.finish(oldEnter);
  assert.equal(f.state.renderedDirection, 'pay');
  assert.equal(f.state.switching, true, 'Old entry cannot clear a newer busy guard');
  f.finish(newExit);
  f.finish(f.animations.at(-1));
  f.assertResting('collect');
  f.hooks.unmount();
}
for (const changes of [
  { enabled: false },
  { resetKey: 'account-a/vault-a/844/search0' },
  { resetKey: 'account-a/vault-b/390/search0' },
  { resetKey: 'account-b/vault-a/390/search0' },
  { resetKey: 'account-a/vault-a/390/search1' },
]) {
  for (const phase of ['exit', 'enter']) {
    const f = fixture();
    f.update({ direction: 'pay' });
    if (phase === 'enter') f.finish(f.animations[0]);
    const pending = f.animations.at(-1);
    f.update(changes);
    assert.ok(pending.stopped);
    f.assertResting('pay');
    const count = f.animations.length;
    f.finish(pending);
    f.assertResting('pay');
    assert.equal(f.animations.length, count, 'Canceled completion starts no new phase');
    f.hooks.unmount();
  }
}
for (const phase of ['exit', 'enter']) {
  const f = fixture();
  f.update({ direction: 'pay' });
  if (phase === 'enter') f.finish(f.animations[0]);
  const pending = f.animations.at(-1);
  f.state.cancel(); // Focus/AppState departure or explicit cancellation.
  f.render();
  f.assertResting('pay');
  f.finish(pending);
  f.assertResting('pay');
  f.hooks.unmount();
}
{
  const f = fixture();
  f.update({ direction: 'pay' });
  const pending = f.animations[0];
  f.setCurrent(false);
  f.finish(pending);
  assert.equal(f.state.renderedDirection, 'collect', 'Live ownership guard rejects completion before cleanup');
  assert.equal(f.animations.length, 1, 'Rejected completion starts no entry');
  f.state.cancel(); f.render();
  f.assertResting('pay');
  f.hooks.unmount();
}
{
  const f = fixture();
  f.update({ direction: 'pay' });
  f.finish(f.animations[0], false);
  assert.equal(f.state.renderedDirection, 'collect', 'Unfinished exit cannot publish destination');
  assert.equal(f.animations.length, 1);
  f.state.cancel(); f.render();
  f.assertResting('pay');
  f.hooks.unmount();
}
for (const phase of ['exit', 'enter']) {
  const f = fixture();
  f.update({ direction: 'pay' });
  if (phase === 'enter') f.finish(f.animations[0]);
  const pending = f.animations.at(-1);
  f.hooks.unmount();
  assert.ok(pending.stopped);
  const writes = f.hooks.lateWrites;
  f.complete(pending);
  assert.equal(f.hooks.lateWrites, writes, 'Late native completion cannot update unmounted state');
  checks++;
}
console.log(JSON.stringify({ allPassed: true, hostOnly: true, checks,
  sourceSha256: { 'lib/use-home-page-transition.ts': crypto.createHash('sha256').update(fs.readFileSync(hookFile)).digest('hex') },
  boundaryStubs: ['React hook/effect scheduling via uiHooks; layout effects share its controlled queue', 'Animated.Value storage', 'native timing/completion delivery'],
  limitation: 'Actual hook lifecycle and destination timing; native rendering, gesture arbitration and frame times require device QA.' }, null, 2));
