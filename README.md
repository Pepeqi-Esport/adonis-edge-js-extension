# Adonis Edge JS

VS Code helpers for AdonisJS routes and Edge templates.

## Features

1. [Go to Controller from Route](#1-go-to-controller-from-route)
2. [Formatter for Edge JS](#2-formatter-for-edge-js)
3. [Go to File from `publicAsset` / `@vite` / `@include` / `@component` / `@!input`](#3-go-to-file-from-publicasset--vite--include--component--input)
4. [Edge Spacer](#4-edge-spacer)

---

### 1. Go to Controller from Route

Ctrl/Cmd+Click in route files to jump to controller files and methods.

#### Supported Files

- `**/routes/**/*.ts` — route modules
- `**/routes/*.ts` — flat routes folders
- `**/start/routes.ts` — main routes file

#### Supported Click Targets

1. **Barrel controllers (AdonisJS generated)** — click method or property

```typescript
import { controllers } from "#generated/controllers";

router.get("/posts", [controllers.Posts, "index"]);
// Click 'index' → posts_controller.ts method index
// Click Posts  → posts_controller.ts
```

2. **Lazy-imported controller variables**

```typescript
const AuthController = () =>
  import("#controllers/dashboard/auth/auth_controller");

router.get("/login", [AuthController, "login"]);
// Click 'login' or AuthController → auth_controller.ts (method when clicking the string)
```

3. **Magic strings** — click path or method inside one string

```typescript
router.get("/", "#controllers/dashboard/auth/auth_controller.index");
// Click path   → auth_controller.ts
// Click index  → auth_controller.ts method index
```

4. **`#controllers/...` import path strings**

```typescript
const UserController = () => import("#controllers/user_controller");
// Click '#controllers/user_controller'
```

Nested barrel keys are supported, e.g. `[controllers.auth.Login, 'handle']` .

---

### 2. Formatter for Edge JS

Built-in formatter for `.edge` templates — use Shift+Alt+F, Format Document, or format on save. Focuses on Edge directives and HTML structure (no syntax highlighting grammar in this package).

#### What it does

1. Repair broken HTML tags split across lines (`</span` + `>` → `</span>`)
2. Put inline Edge directives on their own lines
3. Join multi-line HTML attributes into one line, then wrap like **blade-formatter** (`wrapAttributes`)
4. Convert simple `@if` / `@else` / `@end` plain-text branches to `{{ cond ? 'a' : 'b' }}`
5. Optionally collapse short single-content HTML blocks (off by default so `<label>` / form controls stay multiline)
6. Indent nested `@component` / `@slot` / `@if` / `@each` / HTML / `<script>` / `<style>`
7. Format `@!component` / custom short tags (`@!input`): keep fully inline calls on one line; if any prop is already split across lines, expand to indented one-prop-per-line

Attribute wrap modes (same as `shufo.vscode-blade-formatter`): `auto` (default, pack to `printWidth`) | `force` | `force-aligned` | `force-expand-multiline` | `aligned-multiple` | `preserve` | `preserve-aligned`.

Component props example (multiline intentional break → expanded):

```edge
@!component('components/input', {
    label: 'Email',
    name: 'email',
    placeholder: 'Masukkan Email',
    autocomplete: 'off'
})
```

Example with `auto` + `printWidth` 140:

```edge
<input type="text" class="form-control regex-number" name="price" id="price" value="{{ FormatterHelper.formatNumber(product.price) }}"
    onkeyup="formatNumberElement(this)" onpaste="formatNumberElement(this)" placeholder="Masukkan Harga" autocomplete="off">
```

#### Also

- Auto-align `@end` / `@endsection` while typing
- Command / context menu: **Edge: Convert HTML Comments to Edge Comments**
  {{--  --}}l convert HTML comments → `{{-- --}}` on save
- Default indent / tab size: **4**
- Dynamic snippets for custom components under `resources/views/components` (via `edge.disks`): type `@!` / component name to insert `@!tag({ props })` with inferred props

```json
// .vscode/settings.json
{
  "[edge]": {
    "editor.defaultFormatter": "codenameryuu.adonis-edge-js",
    "editor.formatOnSave": true,
    "editor.tabSize": 4,
    "editor.links": false
  },
  "edge.format.indentSize": 4,
  "edge.format.printWidth": 140,
  "edge.format.wrapAttributes": "auto",
  "edge.format.wrapAttributesMinAttrs": 2,
  "edge.format.collapseShortBlocks": false,
  "edge.format.convertHtmlCommentsOnSave": false
}
```

---

### 3. Go to File from `publicAsset` / `@vite` / `@include` / `@component` / `@!input`

In `.edge` files, `editor.links` is off by default so relative HTML `href` / `src` / `action` values (e.g. `/logout`, `{{ auth.user.profileFileUrl }}`) are **not** underlined.

Only these get link-style underlines:

- `publicAsset('...')` / `@vite('...')` / `@include('...')` / `@component('...')` — Ctrl/Cmd+Click opens the file
- Custom short tags like `@!input` / `@!form.field` (from `resources/views/components/**/*.edge`) — Ctrl/Cmd+Click opens the component file
- Absolute `http://` / `https://` in HTML URL attrs — hover → **Open URL**

#### `publicAsset`

Register the Edge global helper in your app (e.g. a provider / Edge setup):

```typescript
edge.global("publicAsset", (path: string) => {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return cleanPath;
});
```

Then use it in templates:

```edge
<img src="{{ publicAsset('assets/dashboard/custom/image/logo/logo.png') }}" width="80">
```

- Underlined; Ctrl/Cmd+Click opens `public/assets/dashboard/custom/image/logo/logo.png`
- Leading `/` is optional

#### `url`

Register the Edge global helper (absolute URL from your app base URL):

```typescript
edge.global("url", (path: string = "") => {
  const baseUrl = appUrl.replace(/\/$/, "");
  const cleanPath = path.replace(/^\/+/, "");

  return cleanPath ? `${baseUrl}/${cleanPath}` : baseUrl;
});
```

Then use it in templates:

```edge
<img src="{{ url('assets/dashboard/custom/image/logo/logo.png') }}" width="80">
<a href="{{ url('dashboard') }}">Dashboard</a>
```

#### `@vite`

```edge
@vite('resources/views/dashboard/pages/product/create.js')
@vite(['resources/css/app.css', 'resources/js/app.js'])
```

- Each path string is underlined; Ctrl/Cmd+Click opens it from the project root

#### `@include` / `@component`

```edge
@include('dashboard/partials/sidebar')
@component('dashboard/layouts/main')
@!component('dashboard/layouts/main')
```

- Underlined; Ctrl/Cmd+Click opens `resources/views/<path>.edge` (default disk)
- Disk prefix supported: `docs::guide/intro` → disk `docs` from `edge.disks`

#### Custom component short tags

```edge
@!input({ name: 'email' })
@!form.field({ label: 'Title' })
```

- Tag name is underlined when `resources/views/components/<tag>.edge` exists (dots → folders, e.g. `form.field` → `components/form/field.edge`)
- Ctrl/Cmd+Click opens that component file
- Named disks: `@!uikit.input` → disk `uikit` + `components/input.edge` when configured in `edge.disks`

#### Absolute HTML URLs

```edge
<link href="https://fonts.googleapis.com/css2?family=Public+Sans&display=swap" rel="stylesheet">
```

- Underlined; hover → **Open URL**
- Relative attrs like `href="/dashboard"`, `src="/assets/..."`, `action="/logout"` stay plain (no underline)

---

### 4. Edge Spacer

Typing Edge mustache tags auto-inserts inner spaces for easier editing:

- `{{}}` → `{{ | }}` (escaped)
- `{{{}}}` → `{{{ | }}}` (unescaped)

Only active in `.edge` files. Auto-close stays enabled (`{{` → `}}`, `{{{` → `}}}`).

---

## How It Works

- Resolves within the project root (nearest `package.json`)
- Routes: barrel / lazy import / magic string → controller via `package.json#imports`
- Edge formatter: document / range / on-type formatting for `.edge` files
- Edge: component call props formatting for `@!component` / `@!input`-style short tags
- Edge: dynamic completion snippets for `components/**/*.edge` (props inferred from template)
- Edge: `editor.links` off — relative HTML attrs / Edge expressions in `src` are not follow-linked
- Edge: custom underlines for `publicAsset` / `@vite` / `@include` / `@component` / `@!input` short tags / absolute `http(s)`
- Edge: those helpers + custom component tags → Go to Definition; absolute `http(s)` → hover Open URL
- Edge spacer: watches typing of `{{ }}` / `{{{ }}}` and expands with spaces

## Requirements

- VS Code 1.75.0 or later
- AdonisJS project with TypeScript (for route goto)
- `package.json#imports` mapping for `#controllers/*`
- For barrel style: generated `.adonisjs/server/controllers.ts` (or `#generated/*` import map)

## Installation

1. Install the extension
2. Open an AdonisJS project
3. Ctrl/Cmd+Click supported targets in routes or Edge files
4. Format `.edge` with Shift+Alt+F (or enable format on save)

## Limitations

- Only `#controllers/*` (and `#generated/controllers` for barrels) — not `@controllers`
- `publicAsset` → `public/`; `@vite` → project root; `@include` / `@component` → `edge.disks` (default `resources/views`)
- Relative HTML `href` / `src` / `action` are not navigable; only absolute `http(s)` URLs get hover Open URL
- This package does not include an Edge TextMate grammar — install a separate Edge highlighter if you want colors
- Simple `@if` / `@else` plain-text branches may be rewritten to ternaries on format
