# Python Pipeline — GitLab CI with chant

A Python CI pipeline using the `PythonPipeline` composite. Generates test (and optional lint) jobs with virtualenv caching and pytest integration.

## What this generates

```yaml
stages:
  - test

default:
  image:
    name: python:3.12-slim
  cache:
    - key:
        files:
          - requirements.txt
      paths:
        - .pip-cache/
        - .venv/
      policy: pull-push
  before_script:
    - python -m venv .venv
    - source .venv/bin/activate
    - pip install -r requirements.txt

app-test:
  stage: test
  variables:
    PIP_CACHE_DIR: '$CI_PROJECT_DIR/.pip-cache'
  script:
    - source .venv/bin/activate
    - pytest --junitxml=report.xml --cov
  artifacts:
    reports:
      junit: report.xml
    when: always
```

## Try it on GitLab

### 1. Create your project

```bash
chant init --lexicon gitlab --template python-pipeline my-python-app
cd my-python-app
```

### 2. Build the pipeline

```bash
chant build src/ --output .gitlab-ci.yml
```

### 3. Push to GitLab

```bash
git init -b main
git add -A
git commit -m "Initial pipeline"
git remote add origin git@gitlab.com:YOUR_GROUP/YOUR_PROJECT.git
git push -u origin main
```

The pipeline runs automatically on push.

## Project structure

| File | Purpose |
|------|---------|
| `src/pipeline.ts` | `PythonPipeline` composite — generates test + lint jobs |
| `app.py` | Scaffold application |
| `test_app.py` | Scaffold test (pytest) |
| `requirements.txt` | Python dependencies (`pytest`, `pytest-cov`) |

## Customizing

Edit `src/pipeline.ts` to change Python version or add linting:

```typescript
export const app = PythonPipeline({
  pythonVersion: "3.11",                         // default: "3.12"
  testCommand: "pytest --junitxml=report.xml",   // default includes --cov
  lintCommand: "ruff check .",                   // default: "ruff check .", set null to omit
  usePoetry: true,                               // use poetry instead of pip
});
```

## Using the chant-gitlab skill

If you use Claude Code, the `chant-gitlab` skill can scaffold, build, validate, and deploy this pipeline for you. Try:

- "Create a Python CI pipeline and deploy it to GitLab"
- "Build my pipeline and validate it"

The skill handles `chant init --template python-pipeline`, `chant build`, lint validation, and the full push-to-GitLab workflow. It also knows that `PythonPipeline` defaults to `pytest --cov`, which requires `pytest-cov` in your `requirements.txt`.
