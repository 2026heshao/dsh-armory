// ESLint 9 扁平配置。刻意不用 `@eslint/js` 与 `globals` 包：
//   1. 本仓库没有 node_modules（靠宿主 profile 解析依赖），多引一个包就多一条 CI 断链；
//   2. 规则集小到可以手写，全局变量也只需声明真正用到的那些。
// 目标不是「全风格统一」（那需要重排 2 万行，见历史 OPT-10），而是**抓真缺陷**：
// 未定义标识符、死变量、空分支。它已经抓到过两类真实问题：
//   - `test/mcp-config.mjs` 里定义了但从未调用的 `skip()`（「缺包时 SKIP」根本没接上）
//   - `lib/client.js` 里引用 `react-hooks/exhaustive-deps` 的 disable 指令，而该插件从未安装
//     （这条 disable 一直没生效过）

const NODE_GLOBALS = {
  process: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  fetch: 'readonly',
  performance: 'readonly',
};

// lib/client.js 是浏览器 bundle（`window.__ModuleLoader__.load({...})` 自执行工厂），
// 它没有 process / Buffer，但有 DOM 与浏览器专有 API。
const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  // history 与 location 同为浏览器的全局对象：`writeHashParams` 用它 replaceState
  // 同步「当前作用域 / 分类」到 hash，是合法的浏览器用法，不是笔误。
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  console: 'readonly',
  globalThis: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  structuredClone: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  fetch: 'readonly',
  performance: 'readonly',
  ResizeObserver: 'readonly',
  MutationObserver: 'readonly',
  IntersectionObserver: 'readonly',
  // 这三个在浏览器里是 window 上的方法，扁平配置下仍需显式声明
  confirm: 'readonly',
  alert: 'readonly',
  prompt: 'readonly',
};

const RULES = {
  // args: "none" —— 刻意不管未使用的函数参数。这里有一类有意的「占位参数」：
  // 组件按统一签名接收 (props, context) 但只用其一，报出来全是噪音。
  // caughtErrors: "none" —— `catch {}` 允许省略绑定（ES2019 起就是合法的），
  // 而 `catch (e) {}` 里不用 e 通常是为了满足「必须有绑定」的旧写法。
  'no-unused-vars': [
    'error',
    {
      args: 'none',
      caughtErrors: 'none',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],
  'no-undef': 'error',
  'no-empty': 'error',
  // 下面几条零成本、无误报，纯抓笔误
  'no-const-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-sparse-arrays': 'error',
};

export default [
  {
    ignores: ['node_modules/**', '.ai-memory/**', 'docs/**'],
  },
  {
    // 后端与测试：Node ESM
    files: ['lib/**/*.js', 'test/**/*.mjs'],
    ignores: ['lib/client.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: RULES,
  },
  {
    // 浏览器 bundle
    files: ['lib/client.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
    rules: RULES,
  },
];
