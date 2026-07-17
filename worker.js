// ═══════════════════════════════════════════════════════════
// froufrou and loukoum — сервер
//
// Отвечает за:
//   /api/products      витрина берёт список вещей
//   /img/<key>         отдаёт фото из R2
//   /admin             админка (под паролем)
//   /api/admin/*       действия админки
//
// Пароль хранится в секрете ADMIN_PASSWORD, не в коде.
// Ключ Stripe — в секрете STRIPE_SECRET_KEY.
// ═══════════════════════════════════════════════════════════

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

const slug = (s) =>
  s.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "item";

// ── авторизация ──────────────────────────────────────────
// Пароль сверяется побайтово, чтобы время ответа не выдавало
// правильные символы.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Куки: значение + подпись + срок. Подделать без пароля нельзя.
async function makeToken(secret) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 7; // 7 дней
  const body = String(exp);
  return `${body}.${await sign(body, secret)}`;
}

async function checkToken(token, secret) {
  if (!token || !token.includes(".")) return false;
  const [body, sig] = token.split(".");
  if (!safeEqual(sig, await sign(body, secret))) return false;
  return Number(body) > Date.now();
}

async function isAuthed(request, env) {
  const secret = env.ADMIN_PASSWORD;
  if (!secret) return false;
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/fl_admin=([^;]+)/);
  return m ? checkToken(decodeURIComponent(m[1]), secret) : false;
}

// ── Stripe ───────────────────────────────────────────────
// Создаёт товар + цену + ссылку на оплату одним заходом.
async function stripeCall(env, path, params) {
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + env.STRIPE_SECRET_KEY,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(params)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Stripe error");
  return data;
}

async function createStripeLink(env, { name, price, description }) {
  if (!env.STRIPE_SECRET_KEY) return { url: "", priceId: "" };

  const product = await stripeCall(env, "products", {
    name,
    description: (description || "Made to order.").slice(0, 350)
  });

  const priceObj = await stripeCall(env, "prices", {
    product: product.id,
    currency: "eur",
    unit_amount: String(Math.round(price * 100))
  });

  const link = await stripeCall(env, "payment_links", {
    "line_items[0][price]": priceObj.id,
    "line_items[0][quantity]": "1",
    "shipping_address_collection[allowed_countries][0]": "PL",
    "shipping_address_collection[allowed_countries][1]": "DE",
    "shipping_address_collection[allowed_countries][2]": "FR",
    "shipping_address_collection[allowed_countries][3]": "IT",
    "shipping_address_collection[allowed_countries][4]": "ES",
    "shipping_address_collection[allowed_countries][5]": "NL",
    "shipping_address_collection[allowed_countries][6]": "BE",
    "shipping_address_collection[allowed_countries][7]": "AT",
    "shipping_address_collection[allowed_countries][8]": "GB",
    "shipping_address_collection[allowed_countries][9]": "US",
    "custom_fields[0][key]": "measurements",
    "custom_fields[0][label][type]": "custom",
    "custom_fields[0][label][custom]": "Height and measurements",
    "custom_fields[0][type]": "text",
    "custom_fields[0][optional]": "true"
  });

  return { url: link.url, priceId: priceObj.id };
}

// ── чтение витрины ───────────────────────────────────────
async function listProducts(env, includeHidden = false) {
  const where = includeHidden ? "" : "WHERE published = 1";
  const { results } = await env.DB.prepare(
    `SELECT * FROM products ${where} ORDER BY sort_order ASC, created_at DESC`
  ).all();

  if (!results.length) return [];

  const ids = results.map(r => r.id);
  const ph = ids.map(() => "?").join(",");
  const { results: imgs } = await env.DB.prepare(
    `SELECT product_id, key FROM images WHERE product_id IN (${ph}) ORDER BY position ASC`
  ).bind(...ids).all();

  const byProduct = {};
  for (const im of imgs) (byProduct[im.product_id] ||= []).push("/img/" + im.key);

  return results.map(r => ({
    id: r.id,
    name: r.name,
    category: r.category,
    price: r.price,
    year: r.year,
    origin: r.origin,
    sizes: (r.sizes || "").split(",").map(s => s.trim()).filter(Boolean),
    description: r.description,
    composition: r.composition,
    sizing: r.sizing,
    stripe: r.stripe_url || "",
    published: r.published,
    images: byProduct[r.id] || []
  }));
}

// ── создание таблиц ───────────────────────────────────────
// Обычно таблицы создают отдельной командой из терминала.
// Здесь Worker делает это сам при первом запросе — чтобы
// установка была возможна без компьютера.
let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price INTEGER NOT NULL,
      year TEXT DEFAULT 'AW26',
      origin TEXT DEFAULT 'Warsaw',
      sizes TEXT DEFAULT 'XS,S,M,L,XL',
      description TEXT DEFAULT '',
      composition TEXT DEFAULT '',
      sizing TEXT DEFAULT '',
      stripe_url TEXT DEFAULT '',
      stripe_price TEXT DEFAULT '',
      published INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      key TEXT NOT NULL,
      position INTEGER DEFAULT 0
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_images_product
      ON images(product_id, position)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_products_pub
      ON products(published, sort_order)`)
  ]);
  schemaReady = true;
}

// ── маршруты ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (env.DB) await ensureSchema(env);
      // фото из R2
      if (path.startsWith("/img/")) {
        const key = decodeURIComponent(path.slice(5));
        const obj = await env.BUCKET.get(key);
        if (!obj) return new Response("Not found", { status: 404 });
        const h = new Headers();
        obj.writeHttpMetadata(h);
        h.set("etag", obj.httpEtag);
        h.set("cache-control", "public, max-age=31536000, immutable");
        return new Response(obj.body, { headers: h });
      }

      // витрина
      if (path === "/api/products") {
        return json(await listProducts(env));
      }

      // вход в админку
      if (path === "/api/admin/login" && request.method === "POST") {
        const { password } = await request.json();
        if (!env.ADMIN_PASSWORD) return json({ error: "Пароль не настроен" }, 500);
        if (!safeEqual(password || "", env.ADMIN_PASSWORD))
          return json({ error: "Неверный пароль" }, 401);

        const token = await makeToken(env.ADMIN_PASSWORD);
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": `fl_admin=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`
          }
        });
      }

      if (path === "/api/admin/logout") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": "fl_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
          }
        });
      }

      // всё ниже — только для входа
      if (path.startsWith("/api/admin/")) {
        if (!await isAuthed(request, env)) return json({ error: "Нужен вход" }, 401);

        // список всех вещей, включая скрытые
        if (path === "/api/admin/products") {
          return json(await listProducts(env, true));
        }

        // добавить вещь
        if (path === "/api/admin/product" && request.method === "POST") {
          const b = await request.json();
          if (!b.name || !b.price) return json({ error: "Нужны название и цена" }, 400);

          const id = slug(b.name) + "-" + Math.random().toString(36).slice(2, 6);
          let stripeUrl = "", stripePrice = "";

          if (b.makeStripe) {
            try {
              const s = await createStripeLink(env, {
                name: b.name, price: Number(b.price), description: b.description
              });
              stripeUrl = s.url; stripePrice = s.priceId;
            } catch (e) {
              return json({ error: "Stripe: " + e.message }, 400);
            }
          }

          await env.DB.prepare(
            `INSERT INTO products
             (id,name,category,price,year,origin,sizes,description,composition,sizing,
              stripe_url,stripe_price,published,sort_order)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            id, b.name, b.category || "dresses", Number(b.price),
            b.year || "AW26", b.origin || "Warsaw",
            (b.sizes || "XS,S,M,L,XL"),
            b.description || "", b.composition || "", b.sizing || "",
            stripeUrl, stripePrice, b.published === false ? 0 : 1,
            Number(b.sort_order) || 0
          ).run();

          return json({ ok: true, id, stripe: stripeUrl });
        }

        // изменить вещь
        if (path.startsWith("/api/admin/product/") && request.method === "PUT") {
          const id = path.split("/").pop();
          const b = await request.json();
          await env.DB.prepare(
            `UPDATE products SET name=?,category=?,price=?,sizes=?,description=?,
             composition=?,sizing=?,stripe_url=?,published=?,sort_order=? WHERE id=?`
          ).bind(
            b.name, b.category, Number(b.price), b.sizes || "XS,S,M,L,XL",
            b.description || "", b.composition || "", b.sizing || "",
            b.stripe || "", b.published ? 1 : 0, Number(b.sort_order) || 0, id
          ).run();
          return json({ ok: true });
        }

        // удалить вещь вместе с фото
        if (path.startsWith("/api/admin/product/") && request.method === "DELETE") {
          const id = path.split("/").pop();
          const { results } = await env.DB.prepare(
            "SELECT key FROM images WHERE product_id = ?"
          ).bind(id).all();
          for (const r of results) await env.BUCKET.delete(r.key);
          await env.DB.prepare("DELETE FROM images WHERE product_id = ?").bind(id).run();
          await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
          return json({ ok: true });
        }

        // загрузить фото
        if (path === "/api/admin/upload" && request.method === "POST") {
          const form = await request.formData();
          const file = form.get("file");
          const productId = form.get("product_id");
          if (!file || !productId) return json({ error: "Нужны файл и товар" }, 400);
          if (file.size > 6 * 1024 * 1024) return json({ error: "Фото больше 6 MB" }, 400);

          const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
          if (!["jpg", "jpeg", "png", "webp"].includes(ext))
            return json({ error: "Только jpg, png или webp" }, 400);

          // Тип берём по расширению: браузер его иногда не присылает,
          // а без него фото скачивается вместо показа.
          const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg",
                         png: "image/png", webp: "image/webp" };

          const key = `${productId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
          await env.BUCKET.put(key, file.stream(), {
            httpMetadata: { contentType: MIME[ext] }
          });

          const row = await env.DB.prepare(
            "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM images WHERE product_id = ?"
          ).bind(productId).first();

          await env.DB.prepare(
            "INSERT INTO images (product_id, key, position) VALUES (?,?,?)"
          ).bind(productId, key, row.next).run();

          return json({ ok: true, url: "/img/" + key });
        }

        // удалить фото
        if (path === "/api/admin/image" && request.method === "DELETE") {
          const { key } = await request.json();
          await env.BUCKET.delete(key);
          await env.DB.prepare("DELETE FROM images WHERE key = ?").bind(key).run();
          return json({ ok: true });
        }

        return json({ error: "Не найдено" }, 404);
      }

      // страница админки: /admin отдаёт файл admin.html
      if (path === "/admin" || path === "/admin/") {
        const res = await env.ASSETS.fetch(new URL("/admin.html", url.origin));
        return new Response(res.body, {
          status: res.status,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-robots-tag": "noindex, nofollow"
          }
        });
      }

      return env.ASSETS.fetch(request);

    } catch (err) {
      return json({ error: err.message || "Ошибка сервера" }, 500);
    }
  }
};
