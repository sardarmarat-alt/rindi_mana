# Rindi Mana website

Static site (no build step). Files:

- `index.html` – the whole site (home + "Our wine" page, Armenian / English / Russian)
- `images/` – photos used by the site

## Deploy on Vercel (via GitHub)
1. Create a new GitHub repository and upload these files (keep the `images` folder).
2. On vercel.com choose **Add New > Project**, import the repository.
3. Framework Preset: **Other**. Leave build command and output directory empty. Click **Deploy**.

## Add your own photos
Put the image files in `images/`. In `index.html`, find the four `<div class="slot" ...>` lines in the "Bottles and vineyards" section and replace each with
`<img class="pic" src="images/your-photo.jpg" alt="Description">`.

## Change contact details
Search `index.html` for `kamari.cheese@gmail.com`, `044 53 09 09` and `096 19 04 24`.

## Order form
The form opens the visitor's email app with the request filled in. To receive orders directly, connect it to a form service such as Formspree or Vercel serverless functions.
