# Recipe file format

Each recipe is one `.md` file in this folder. It stays readable in any text
editor or on github.com directly, even without the app.

```
---
{
  "title": "Pancakes",
  "image": "images/example-pancakes.jpg",
  "ingredients": [
    { "id": "flour", "name": "Flour", "amount": 250, "unit": "g" },
    { "id": "milk", "name": "Milk", "amount": 400, "unit": "ml" },
    { "id": "eggs", "name": "Eggs", "amount": 2, "unit": "pcs" }
  ]
}
---

1. Whisk {flour} with {milk} until smooth.
2. Beat in the {eggs}.
3. Fry spoonfuls in a hot, buttered pan until golden on both sides.
```

- `amount` is always the value for the *original* (unscaled) recipe.
- `unit` must be one of: g, kg, ml, l, tsp, tbsp, cup, pcs.
- `{id}` placeholders inside the numbered steps get replaced with the
  scaled amount automatically — the `id` must match an ingredient's `id`.
- Total weight is calculated from the `g`/`kg` ingredients. Scaling the
  total weight in the app multiplies every ingredient (including
  non-weight ones like `pcs`) by the same factor.
- `images/<slug>.jpg` holds the photo. Optional — leave `image` blank if
  there isn't one.

`index.json` in this folder is just a cache the app keeps for fast list
loading. If it's ever lost or wrong, the app will rebuild it correctly
the next time you save any recipe — the `.md` files are always the
source of truth.
