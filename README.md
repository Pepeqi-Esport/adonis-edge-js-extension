# Adonis Edge JS

VS Code helpers for AdonisJS routes and Edge templates.

## Features

1. [Go to Controller from Route](#1-go-to-controller-from-route)
2. [Formatter for Edge JS](#2-formatter-for-edge-js)
3. [Go to File from `publicAsset` / `@vite`](#3-go-to-file-from-publicasset--vite)
4. [Edge Spacer](#4-edge-spacer)

---

### 1. Go to Controller from Route

Ctrl/Cmd+Click in route files to jump to controller files and methods.

#### Supported Files

* `**/routes/**/*.ts` — route modules
* `**/routes/*.ts` — flat routes folders
* `**/start/routes.ts` — main routes file

#### Supported Click Targets

1. **Barrel controllers (AdonisJS generated)** — click method or property

```typescript
import { controllers } from '#generated/controllers'

router.get('/posts', [controllers.Posts, 'index'])
// Click 'index' → posts_controller.ts method index
// Click Posts  → posts_controller.ts
```

2. **Lazy-imported controller variables**

```typescript
const AuthController = () => import('#controllers/dashboard/auth/auth_controller')

router.get('/login', [AuthController, 'login'])
// Click 'login' or AuthController → auth_controller.ts (method when clicking the string)
```

3. **Magic strings** — click path or method inside one string

```typescript
router.get('/', '#controllers/dashboard/auth/auth_controller.index')
// Click path   → auth_controller.ts
// Click index  → auth_controller.ts method index
```

4. **`#controllers/...` import path strings**

```typescript
const UserController = () => import('#controllers/user_controller')
// Click '#controllers/user_controller'
```

Nested barrel keys are supported, e.g. `[controllers.auth.Login, 'handle']` .

---

### 2. Formatter for Edge JS

Built-in formatter for `.edge` templates — use Shift+Alt+F, Format Document, or format on save. Focuses on Edge directives and HTML structure (no syntax highlighting grammar in this package).

#### What it does

1. Repair broken HTML tags split across lines (`</span` + `>` → `</span>`)
2. Put inline Edge directives on their own lines
3. Join multi-line HTML attributes into one line
4. Convert simple `@if` / `@else` / `@end` plain-text branches to `{{ cond ? 'a' : 'b' }}`
5. Optionally collapse short single-content HTML blocks (off by default so `<label>` / form controls stay multiline)
6. Indent nested `@component` / `@slot` / `@if` / `@each` / HTML / `<script>` / `<style>`

#### Also

* Auto-align `@end` / `@endsection` while typing
* Command / context menu: **Edge: Convert HTML Comments to Edge Comments**
* Optional convert HTML comments → `{{-- --}}` on save
* Default indent / tab size: **4**

```json
// .vscode/settings.json
{
  "[edge]": {
    "editor.defaultFormatter": "codenameryuu.adonis-edge-js",
    "editor.formatOnSave": true,
    "editor.tabSize": 4
  },
  "edge.format.indentSize": 4,
  "edge.format.collapseShortBlocks": false,
  "edge.format.convertHtmlCommentsOnSave": false
}
```

---

### 3. Go to File from `publicAsset` / `@vite`

In `.edge` files, path arguments are underlined. Ctrl/Cmd+Click opens the target file.

#### `publicAsset`

Register the Edge global helper in your app (e.g. a provider / Edge setup):

```typescript
edge.global('publicAsset', (path: string) => {
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return cleanPath
})
```

Then use it in templates:

```edge
<img src="{{ publicAsset('assets/dashboard/custom/image/logo/logo.png') }}" width="80">
```

* Underline: `assets/dashboard/custom/image/logo/logo.png`
* Opens: `public/assets/dashboard/custom/image/logo/logo.png`
* Leading `/` is optional

#### `@vite`

```edge
@vite('resources/views/dashboard/pages/product/create.js')
@vite(['resources/css/app.css', 'resources/js/app.js'])
```

* Underline: each path string inside `@vite(...)`
* Opens: path from the project root (not under `public/`)

---

### 4. Edge Spacer

Typing Edge mustache tags auto-inserts inner spaces for easier editing:

* `{{}}` → `{{ | }}` (escaped)
* `{{{}}}` → `{{{ | }}}` (unescaped)

Only active in `.edge` files. Auto-close stays enabled (`{{` → `}}`, `{{{` → `}}}`).

---

## How It Works

* Resolves within the project root (nearest `package.json`)
* Routes: barrel / lazy import / magic string → controller via `package.json#imports`
* Edge formatter: document / range / on-type formatting for `.edge` files
* Edge: `publicAsset('...')` → `public/` + path;  `@vite('...')` → project-root path (Document Links)
* Edge spacer: watches typing of `{{ }}` / `{{{ }}}` and expands with spaces

## Requirements

* VS Code 1.75.0 or later
* AdonisJS project with TypeScript (for route goto)
* `package.json#imports` mapping for `#controllers/*`
* For barrel style: generated `.adonisjs/server/controllers.ts` (or `#generated/*` import map)

## Installation

1. Install the extension
2. Open an AdonisJS project
3. Ctrl/Cmd+Click supported targets in routes or Edge files
4. Format `.edge` with Shift+Alt+F (or enable format on save)

## Limitations

* Only `#controllers/*` (and `#generated/controllers` for barrels) — not `@controllers`
* `publicAsset` links resolve under `public/`; `@vite` links resolve from the project root
* This package does not include an Edge TextMate grammar — install a separate Edge highlighter if you want colors
* Simple `@if` / `@else` plain-text branches may be rewritten to ternaries on format
