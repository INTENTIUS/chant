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
│   │       ├── getting-started/   # Quick start and setup
│   │       ├── concepts/          # Core concepts
│   │       ├── cli/               # CLI command reference
│   │       ├── architecture/      # Architecture deep dives
│   │       ├── lexicons/          # Lexicon-specific docs
│   │       ├── lexicon-authoring/ # Authoring custom lexicons
│   │       ├── lint-rules/        # Lint rule documentation
│   │       ├── configuration/     # Configuration reference
│   │       ├── serialization/     # Output format details
│   │       ├── tutorials/         # Step-by-step tutorials
│   │       ├── api/               # API documentation
│   │       ├── guide/             # User guides
│   │       ├── contributing/      # Contributor docs
│   │       └── troubleshooting/   # Troubleshooting guides
│   └── content.config.ts # Content configuration
├── public/               # Static files (favicons, etc.)
├── astro.config.mjs      # Astro + Starlight configuration (includes sidebar)
└── package.json
```

## Writing Documentation

Documentation is written in Markdown or MDX format. Files are located in `src/content/docs/`.

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
3. Add the page to the sidebar in `astro.config.mjs` — Starlight does **not** auto-discover pages

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
