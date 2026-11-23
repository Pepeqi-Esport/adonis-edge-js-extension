# Adonis Edge JS

VS Code extension for Adonis JS 6+ routes and Edge templates.

## Features

1. [Go to Controller from Route](#1-go-to-controller-from-route)
2. [Formatter for Edge JS](#2-formatter-for-edge-js)
3. [Go to File from Edge templates](#3-go-to-file-from-edge-templates)
4. [Edge Spacer](#4-edge-spacer)
5. [Emmet](#5-emmet)
6. [Snippets](#6-snippets)
7. [Generate Module](#7-generate-module)

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

Nested barrel keys are supported, e.g. `[controllers.auth.Login, 'handle']`.

---

### 2. Formatter for Edge JS

Built-in formatter for `.edge` templates — use Shift+Alt+F, Format Document, or format on save. Focuses on Edge directives and HTML structure (no syntax highlighting grammar in this package).

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

### 3. Go to File from Edge templates

#### `publicAsset`

Register the Edge global helper in your app (e.g. `start/view.ts` / a provider):

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

- Path argument is underlined; Ctrl/Cmd+Click opens `public/assets/dashboard/custom/image/logo/logo.png`
- Leading `/` is optional

#### `@vite`

```edge
@vite('resources/views/dashboard/pages/product/create.js')
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

Matches Edge’s filename → tag rules (scan `components/**/*.edge`):

| Template path | Tag name |
| --- | --- |
| `input.edge` | `@!input` |
| `input_password.edge` | `@!inputPassword` |
| `form/field.edge` | `@!form.field` |
| `checkout_form/input.edge` | `@!checkoutForm.input` |
| `modal/index.edge` | `@!modal` |

```edge
@!input({ name: 'email' })
@!inputPassword({ label: 'Password', name: 'password' })
@!form.field({ label: 'Title' })
```

- Tag name is underlined when the component file exists
- Ctrl/Cmd+Click opens that component file
- Named disks: `@!uikit.input` → disk `uikit` + `components/input.edge` when configured in `edge.disks`

#### `edge.global` helpers

Registrations are discovered from `start/`, `providers/`, and `app/providers/` (e.g. `start/view.ts`):

```typescript
import FormatterHelper from "#helpers/formatter_helper";

edge.global("FormatterHelper", FormatterHelper);
```

Then in templates:

```edge
@!inputCurrency({
  label: 'Harga',
  prefixText: 'Rp',
  name: 'price',
  value: FormatterHelper.formatNumber(product.price),
  placeholder: 'Enter Price'
})
```

- **Ctrl/Cmd+Click `FormatterHelper`** → opens the helper module (`formatter_helper.ts`)
- **Ctrl/Cmd+Click `formatNumber`** → opens the same file and selects that method/function
- Import aliases from `package.json#imports` are resolved (e.g. `#helpers/*`)
- Both identifiers are underlined when the target file exists

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

### 5. Emmet

Emmet abbreviations work in `.edge` templates (mapped to HTML), with Tab expansion enabled by default:

```json
"emmet.includeLanguages": {
  "edge": "html"
},
"emmet.triggerExpansionOnTab": true
```

Example: type `div.card>ul>li*3` then Tab → expands to nested HTML.

---

### 6. Snippets

Bootstrap form snippets for `.edge` files (no `b:` prefix):

| Trigger | Snippet |
| --- | --- |
| `label` | `<label class="form-label">…</label>` |
| `input` | `<input class="form-control" …>` |
| `select` | `<select class="form-select">` with option |
| `option` | `<option>…</option>` |
| `textarea` | `<textarea class="form-control" …>` |

Also includes mustache helpers:

| Trigger | Snippet |
| --- | --- |
| `{{` | `{{ \| }}` |
| `{{{` | `{{{ \| }}}` |

---

### 7. Generate Module

Command palette → **Ace: Generate Module** (`adonis-edge.generateModule`).

Prompts for:

1. **Module name** — e.g. `Product` / `ProductCategory`
2. **Folder path** (optional) — nested with `/`, e.g. `api` or `dashboard/product`
3. **Overwrite** — skip or overwrite existing files

Creates controller, validation, and service from stubs:

| Folder starts with | Stub set | Example targets (`Product` + `dashboard/product`) |
| --- | --- | --- |
| `api` | `stubs/module/api/` | `app/controllers/api/.../product_controller.ts` |
| anything else / empty | `stubs/module/dashboard/` | `app/controllers/dashboard/product/product_controller.ts` |

Generated files:

- `app/controllers/<folder>/<name>_controller.ts`
- `app/validations/<folder>/<name>_validation.ts`
- `app/services/<folder>/<name>_service.ts`

Project stubs under `stubs/module/...` override the extension’s bundled stubs when present. Output is logged to the **Adonis Edge Generate Module** channel.
