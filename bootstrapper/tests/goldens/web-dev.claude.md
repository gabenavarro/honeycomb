# Golden Project

A canonical project description used exclusively by golden-file tests. Keep it plain prose — Jinja-looking input belongs in test_provision_security.py, not here.

## Project Structure

- `src/` or `golden_project/` — application source code.
- `src/components/` — UI components (if frontend).
- `src/api/` or `src/routers/` — API endpoints (if backend).
- `src/services/` — business logic layer.
- `src/models/` — data models (Pydantic, SQLAlchemy, TypeScript interfaces).
- `tests/` — unit and integration tests.
- `public/` or `static/` — static assets.

## Backend Conventions (Python)

- **Framework**: FastAPI preferred. Async endpoints by default.
- **Data models**: Pydantic v2 for request/response schemas.
- **Database**: SQLAlchemy 2.0+ with async sessions. Alembic for migrations.
- **Error handling**: raise HTTPException with specific status codes. Custom exception handlers for domain errors.
- **API design**: RESTful. Consistent naming: plural nouns for collections, nested routes for relations.

## Frontend Conventions (TypeScript/React)

- **Framework**: React 19 + Vite. TypeScript strict mode.
- **Components**: Functional components only. Keep components small and focused.
- **State**: TanStack Query for server state. Zustand or React context for UI state.
- **Styling**: Tailwind CSS. No inline styles.
- **Testing**: Vitest + Testing Library.

## Coding Conventions

- Python: type hints, `ruff` format/lint, Google-style docstrings.
- TypeScript: strict mode, ESLint + Prettier, no `any` types.
- Format on save. Lint before commit.

## Testing

- Backend: `pytest` + `httpx` for API tests.
- Frontend: `vitest` + `@testing-library/react`.
- Run all tests before committing.

## Git Workflow

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Feature branches off `main`. PRs require passing CI.
- Do NOT commit `.env`, `node_modules/`, `__pycache__/`.
