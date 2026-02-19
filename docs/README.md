# chant Documentation

This directory contains the documentation site for chant, built with [Astro Starlight](https://starlight.astro.build/).

## Development

```bash
# Start dev server
bun --cwd docs dev

# Build documentation
bun --cwd docs build

# Preview production build
bun --cwd docs preview
```

The dev server will start at `http://localhost:4321`.

## Project Structure

```
docs/
├── src/
│   ├── assets/           # Static assets (images, etc.)
│   ├── content/
│   │   └── docs/         # Documentation content (MDX/Markdown)
│   │       ├── guides/   # User guides
│   │       ├── reference/# Reference documentation
│   │       └── api/      # API documentation
│   └── content.config.ts # Content configuration
├── public/               # Static files (favicons, etc.)
├── astro.config.mjs      # Astro configuration
└── package.json
```

## Writing Documentation

Documentation is written in Markdown or MDX format. Files are located in `src/content/docs/`.

### File Structure

- **Guides** (`guides/`) - Tutorials and conceptual guides
  - `getting-started.md` - Quick start guide
- **Advanced** (`advanced/`) - In-depth technical documentation
  - `core-type-system.md` - Core type system deep dive

- **Reference** (`reference/`) - Technical reference documentation
  - `cli.md` - CLI command reference

- **API** (`api/`) - Generated API documentation

### Frontmatter

Each documentation page requires frontmatter:

```yaml
---
title: Page Title
description: Brief description of the page
---
```

## Adding New Pages

1. Create a new `.md` or `.mdx` file in the appropriate directory
2. Add frontmatter with title and description
3. The page will automatically appear in navigation based on file location

## Starlight Features

Starlight provides built-in components for enhanced documentation:

```mdx
import { Card, CardGrid, Tabs, TabItem } from '@astrojs/starlight/components';

<Card title="Feature" icon="rocket">
  Description of the feature
</Card>
```

See [Starlight documentation](https://starlight.astro.build/) for more components and features.

## Deployment

The documentation site can be deployed to any static hosting service:

```bash
# Build for production
bun --cwd docs build

# Output will be in docs/dist/
```

## Links

- [chant Repository](https://github.com/intentius/chant)
- [Starlight Docs](https://starlight.astro.build/)
- [Astro Docs](https://docs.astro.build/)
