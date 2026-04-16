---
name: web-dev-workflow
description: Full-stack web development patterns covering FastAPI backends, React frontends, database patterns, testing strategies, and deployment workflows.
---

# Web Dev Workflow

Patterns for full-stack web development with Python backends and React frontends.

## When to Use This Skill

- Building or modifying FastAPI REST/WebSocket APIs
- Creating React components and frontend features
- Setting up database models and migrations
- Writing API and frontend tests
- Configuring build and deployment pipelines

## Backend Patterns (FastAPI)

### Router Structure
```python
from fastapi import APIRouter, HTTPException, Depends
from app.models import ItemCreate, ItemResponse
from app.services import ItemService

router = APIRouter(prefix="/api/items", tags=["items"])

@router.post("", response_model=ItemResponse, status_code=201)
async def create_item(req: ItemCreate, svc: ItemService = Depends()):
    return await svc.create(req)

@router.get("/{item_id}", response_model=ItemResponse)
async def get_item(item_id: int, svc: ItemService = Depends()):
    item = await svc.get(item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    return item
```

### Service Layer
```python
class ItemService:
    def __init__(self, db: AsyncSession = Depends(get_db)):
        self.db = db

    async def create(self, data: ItemCreate) -> Item:
        item = Item(**data.model_dump())
        self.db.add(item)
        await self.db.commit()
        await self.db.refresh(item)
        return item
```

### Pydantic Models
```python
from pydantic import BaseModel, Field

class ItemCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = ""

class ItemResponse(ItemCreate):
    id: int
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)
```

### SQLAlchemy 2.0 + Alembic
```python
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Item(Base):
    __tablename__ = "items"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
```

## Frontend Patterns (React + TypeScript)

### Component Structure
```tsx
interface Props {
  itemId: number;
}

export function ItemDetail({ itemId }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["items", itemId],
    queryFn: () => api.getItem(itemId),
  });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorMessage error={error} />;
  return <div>{data.name}</div>;
}
```

### API Client
```tsx
const api = {
  getItem: (id: number) =>
    fetch(`/api/items/${id}`).then(r => r.json()),
  createItem: (data: ItemCreate) =>
    fetch("/api/items", { method: "POST", body: JSON.stringify(data) }).then(r => r.json()),
};
```

## Testing

### Backend (pytest + httpx)
```python
@pytest.mark.asyncio
async def test_create_item(client: AsyncClient):
    resp = await client.post("/api/items", json={"name": "Test"})
    assert resp.status_code == 201
    assert resp.json()["name"] == "Test"
```

### Frontend (Vitest + Testing Library)
```tsx
test("renders item name", async () => {
  render(<ItemDetail itemId={1} />);
  expect(await screen.findByText("Test Item")).toBeInTheDocument();
});
```

## Best Practices

- Async-first: all FastAPI endpoints and DB queries should be async
- Validate at boundaries: Pydantic for API input, trust internal code
- Separate concerns: routers → services → models
- Database migrations: always use Alembic, never modify schema directly
- Environment: use `.env` files (gitignored), python-dotenv for loading
- CORS: configure explicitly for production, permissive for local dev
- Error handling: HTTPException with specific status codes, not generic 500s
