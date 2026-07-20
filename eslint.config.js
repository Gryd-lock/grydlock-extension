import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['coverage', 'dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
// CI safeguard: these restricted globals/imports enforce that no network calls are made outside src/adapter/
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/adapter/**/*.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'src/**/*.spec.{ts,tsx}',
      'src/setupTests.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Direct fetch calls are only allowed within the adapter boundary (src/adapter/).',
        },
        {
          name: 'XMLHttpRequest',
          message: 'Direct XMLHttpRequest calls are only allowed within the adapter boundary (src/adapter/).',
        },
        {
          name: 'WebSocket',
          message: 'Direct WebSocket connections are only allowed within the adapter boundary (src/adapter/).',
        },
        {
          name: 'EventSource',
          message: 'Direct EventSource connections are only allowed within the adapter boundary (src/adapter/).',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@stellar/stellar-sdk',
              importNames: ['Server'],
              message: 'Stellar Horizon Server requests are not allowed outside of the adapter boundary (src/adapter/).',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name="fetch"]',
          message: 'Direct fetch calls are only allowed within the adapter boundary (src/adapter/).',
        },
        {
          selector: 'CallExpression[callee.object.name="window"][callee.property.name="fetch"]',
          message: 'window.fetch calls are only allowed within the adapter boundary (src/adapter/).',
        },
        {
          selector: 'CallExpression[callee.object.name="self"][callee.property.name="fetch"]',
          message: 'self.fetch calls are only allowed within the adapter boundary (src/adapter/).',
        },
        {
          selector: 'CallExpression[callee.object.name="globalThis"][callee.property.name="fetch"]',
          message: 'globalThis.fetch calls are only allowed within the adapter boundary (src/adapter/).',
        },
        {
          selector: 'NewExpression[callee.name="XMLHttpRequest"]',
          message: 'XMLHttpRequest is only allowed within the adapter boundary (src/adapter/).',
        },
        {
          selector: 'NewExpression[callee.name="WebSocket"]',
          message: 'WebSocket is only allowed within the adapter boundary (src/adapter/).',
        },
        {
          selector: 'NewExpression[callee.name="EventSource"]',
          message: 'EventSource is only allowed within the adapter boundary (src/adapter/).',
        },
        {
          selector: 'CallExpression[callee.object.name="navigator"][callee.property.name="sendBeacon"]',
          message: 'navigator.sendBeacon is only allowed within the adapter boundary (src/adapter/).',
        },
        {
          selector: 'NewExpression[callee.name="Server"]',
          message: 'Direct Stellar Server instantiation is only allowed within the adapter boundary (src/adapter/).',
        },
        {
          selector: 'NewExpression[callee.object.name="StellarSdk"][callee.property.name="Server"]',
          message: 'Direct Stellar Server instantiation is only allowed within the adapter boundary (src/adapter/).',
        },
      ],
    },
  },
  {
    files: ['playwright.config.ts', 'e2e/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  prettier,
)
