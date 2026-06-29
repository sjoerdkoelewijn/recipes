# Kookboek — setup

A tiny recipe app. No backend, no build step — it's a handful of static
files that talk directly to the GitHub API. Recipes live as plain
markdown files in this same repo, so they survive even if the app itself
ever breaks or you stop using it.

## 1. Create the repo

1. Create a **public** repo on GitHub (e.g. `recipes`).
2. Upload everything in this folder to the root of that repo (keep the
   `recipes/` folder as-is — it already contains one example recipe).
3. Commit to the `main` branch.

## 2. Turn on GitHub Pages

1. In the repo: **Settings → Pages**.
2. Source: **Deploy from a branch** → branch `main`, folder `/ (root)`.
3. Save. After a minute you'll get a URL like
   `https://<username>.github.io/recipes/`.

## 3. Create an access token

Both you and your partner need one each (or you can share one — it's
just the two of you).

1. GitHub → **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
2. Resource owner: your account. Repository access: **only this repo**.
3. Permissions → **Contents: Read and write**. Nothing else is needed.
4. Generate, copy the token (you won't see it again).

## 4. Open the app on your phone

1. Open the Pages URL from step 2 in Chrome / Samsung Internet.
2. It'll send you to **Settings** automatically the first time. Fill in:
   - GitHub username
   - Repo name
   - Branch (`main`)
   - The token from step 3
3. Tap **Save**. Your partner does the same on their phone with their
   own token.
4. Optional: browser menu → **Add to Home screen**, so it sits on your
   phone like a normal app.

The token is stored only in that phone's browser (`localStorage`) — it's
never written into the repo.

## Notes

- Recipes are plain `.md` files in `recipes/`, readable in any text
  editor or directly on github.com. See `recipes/README.md` for the
  exact format if you ever want to add or fix one by hand.
- Photos are compressed to ~1200px wide before upload, so the repo
  stays small even with phone-camera photos.
- Because the repo is public, anyone with the link can *view* your
  recipes, but only people with a valid token can add or edit them.
