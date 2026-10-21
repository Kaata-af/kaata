// Host-only: execute the real single-page Home release gesture with RNGH Pan.
// Keep this script name so existing CI commands continue covering Home swipes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const mobile = path.resolve(__dirname, '../..');
const req = createRequire(path.join(mobile, 'package.json'));
const ts = req('typescript');
const babel = req('@babel/core');
const filename = path.join(mobile, 'app/index.tsx');
const source = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function walk(node) {
  if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), node);
  ts.forEachChild(node, walk);
}
walk(ast);
const gesture = declarations.get('swipeGesture');
assert.ok(gesture?.initializer?.arguments?.[0]?.body, 'Actual Home recognizer must exist');
const constants = ['FLICK_VELOCITY', 'DRAG_COMMIT_FRACTION'];
const inputs = ['Gesture', 'direction', 'screenWidth', 'homeInteraction', 'searchGestureGeneration',
  'searchGestureState', 'mounted', 'selectionOwnerActive', 'activeVaultId', 'activeAccountId',
  'getActiveVaultIdSyncMaybe', 'getAccountIdSync', 'Haptics', 'setDirection'];
const factorySource = constants.map((name) => 'const ' + name + '=' + declarations.get(name).initializer.getText(ast) + ';').join('\n')
  + '\nmodule.exports=(env)=>{const {' + inputs.join(',') + '}=env;'
  + gesture.initializer.arguments[0].body.getText(ast).slice(1, -1) + '};';
const built = babel.transformSync(factorySource, { filename, configFile: false, babelrc: false,
  presets: [[req.resolve('@babel/preset-typescript'), { allExtensions: true, isTSX: true }]],
  plugins: [req.resolve('react-native-worklets/plugin')],
}).code;
const factory = { exports: {} };
vm.runInNewContext(built, { module: factory, exports: factory.exports, global: { Error } });

function evaluateGesture(relative, requireDependency) {
  const file = path.join(mobile, 'node_modules/react-native-gesture-handler/src/handlers/gestures', relative);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: requireDependency });
  return module.exports;
}
const base = evaluateGesture('gesture.ts', (id) => {
  if (id === '../getNextHandlerTag') return { getNextHandlerTag: () => 1 };
  if (id === '../../utils') return { isRemoteDebuggingEnabled: () => false };
  assert.fail('Unexpected gesture dependency: ' + id);
});
const { PanGesture } = evaluateGesture('panGesture.ts', (id) => {
  assert.equal(id, './gesture'); return base;
});
let checks = 0;
function fixture(direction = 'collect', width = 390) {
  const commits = [], haptics = [];
  const live = { vault: 'vault-a', account: 'account-a' };
  const env = {
    Gesture: { Pan: () => new PanGesture() }, direction, screenWidth: width,
    homeInteraction: { current: { busy: false } },
    searchGestureGeneration: 0, searchGestureState: { current: { active: false, generation: 0 } },
    mounted: { current: true }, selectionOwnerActive: { current: true },
    activeVaultId: live.vault, activeAccountId: live.account,
    getActiveVaultIdSyncMaybe: () => live.vault, getAccountIdSync: () => live.account,
    Haptics: { ImpactFeedbackStyle: { Soft: 'soft' }, impactAsync: (style) => {
      haptics.push(style); return Promise.resolve();
    } },
    setDirection: (next) => commits.push(next),
  };
  const pan = factory.exports(env);
  pan.initialize();
  assert.equal(pan.config.runOnJS, true, 'Only the completed release crosses to JS');
  assert.equal(pan.shouldUseReanimated, false, 'Installed RNGH selects JS event delivery');
  assert.deepEqual([pan.config.activeOffsetXStart, pan.config.activeOffsetXEnd], [-24, 24]);
  assert.deepEqual([pan.config.failOffsetYStart, pan.config.failOffsetYEnd], [-16, 16]);
  assert.equal(pan.handlers.onUpdate, undefined, 'Finger movement does not enqueue per-frame JS work');
  assert.equal(typeof pan.handlers.onEnd, 'function');
  return { env, pan, commits, haptics, live };
}

for (const width of [320, 390, 844]) {
  for (const direction of ['collect', 'pay']) {
    const sign = direction === 'collect' ? -1 : 1;
    for (const [distance, velocity, commit] of [
      [sign * width * 0.3, 0, true], [sign * (width * 0.3 - 0.01), 0, false],
      [sign * 25, sign * 500, true], [sign * 25, sign * 499, false],
      [-sign * width, -sign * 1000, false], [0, 0, false],
    ]) {
      const one = fixture(direction, width);
      one.pan.handlers.onEnd({ translationX: distance, velocityX: velocity });
      assert.deepEqual(one.commits, commit ? [direction === 'collect' ? 'pay' : 'collect'] : [],
        'Actual release uses the original 30% drag / 500 velocity thresholds');
      assert.deepEqual(one.haptics, commit ? ['soft'] : [], 'Only a committed swipe vibrates once');
      checks++;
    }
  }
}

for (const invalidate of [
  (f) => { f.env.searchGestureState.current.active = true; },
  (f) => { f.env.searchGestureState.current.generation++; },
  (f) => { f.env.mounted.current = false; },
  (f) => { f.env.selectionOwnerActive.current = false; },
  (f) => { f.live.vault = 'vault-b'; },
  (f) => { f.live.account = 'account-b'; },
  (f) => { f.env.homeInteraction.current.busy = true; },
]) {
  const f = fixture();
  invalidate(f);
  f.pan.handlers.onEnd({ translationX: -200, velocityX: -1000 });
  assert.deepEqual(f.commits, [], 'Stale/search/unfocused/busy gesture cannot change the tab');
  assert.deepEqual(f.haptics, [], 'Rejected gesture cannot vibrate');
  checks++;
}
console.log(JSON.stringify({ allPassed: true, hostOnly: true, checks,
  installedRNGH: req('react-native-gesture-handler/package.json').version,
  homeSourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  boundaryStubs: ['native touch recognition/delivery', 'haptic dispatch'],
  limitation: 'Actual Home callbacks and installed JS routing; native touch arbitration and device frame timing require phone QA.' }, null, 2));
