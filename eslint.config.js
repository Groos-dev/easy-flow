import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import jsdoc from 'eslint-plugin-jsdoc'

/**
 * 一句话的注释别写成多行块（含 JSX 里的 {/* *\/}）：读的人要跳两行才看完。
 * 带 @tag 的块归 jsdoc 规则管，这里只看普通块注释；宽度按中日韩字符占两格算。
 */
const shortBlockComment = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { short: '这段注释一句话就写完了，收成一行' },
  },
  create(context) {
    const source = context.sourceCode
    return {
      Program() {
        for (const comment of source.getAllComments()) {
          if (comment.type !== 'Block' || comment.value.startsWith('*')) continue
          const lines = comment.value
            .split('\n')
            .map((line) => line.replace(/^\s*\*?\s?/, ''))
            .filter(Boolean)
          if (lines.length < 2) continue
          const text = lines.join(' ').trim()
          if (/^(eslint|@|!)/.test(text)) continue
          const width = [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
          if (width <= 100) context.report({ loc: comment.loc, messageId: 'short' })
        }
      },
    }
  },
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/dist-types/**',
      '**/.tmp/**',
      '**/.claude/**',
      '**/.pet-src/**',
      '**/public/pets/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks, jsdoc, local: { rules: { 'short-block-comment': shortBlockComment } } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'local/short-block-comment': 'error',
      'jsdoc/multiline-blocks': ['error', { noSingleLineBlocks: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['server/log.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.*', 'electron.vite.config.ts', 'vite.web.config.ts'],
    languageOptions: { globals: globals.node },
  },
)
