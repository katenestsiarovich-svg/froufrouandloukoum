/* Логика витрины. Данные приходят с сервера, из админки. */

const EMAIL = "kate.nestsiarovich@gmail.com";
let PRODUCTS = [];
const money = n => "€" + n.toLocaleString("en-GB");

let cart = [];
let current = null;
let currentSize = null;
let filter = "all";

/* ── grid ── */
function renderGrid() {
  const list = filter === "all" ? PRODUCTS : PRODUCTS.filter(p => p.category === filter);
  const grid = document.getElementById("grid");

  if (!list.length) {
    grid.classList.add("is-empty");
    grid.innerHTML = `<div class="grid-empty">
      <span class="caps">Coming soon</span>
      <p>The first pieces are being finished now.<br>
      Write to us if you'd like to be told when they arrive.</p>
      <a href="mailto:${EMAIL}" class="caps">Get in touch</a>
    </div>`;
    return;
  }

  grid.classList.remove("is-empty");
  grid.innerHTML = list.map(p => `
    <article class="card" data-id="${p.id}" tabindex="0" role="button">
      <div class="card-img">
        <img src="${p.images[0]}" alt="${p.name}" loading="lazy">
        <div class="slip">
          <span>Cat. <b>${p.id.slice(0, 3).toUpperCase()}</b> · ${p.year}</span>
          <span>Made to order · <b>${p.origin}</b></span>
        </div>
      </div>
      <h3>${p.name}</h3>
      <div class="price">${money(p.price)}</div>
    </article>`).join("");
}

/* ── product panel ── */
function openProduct(id) {
  current = PRODUCTS.find(p => p.id === id);
  currentSize = null;
  document.getElementById("pName").textContent = current.name;
  document.getElementById("pPrice").textContent = money(current.price);
  document.getElementById("pMain").src = current.images[0];
  document.getElementById("pMain").alt = current.name;
  document.getElementById("pDesc").innerHTML = `<p>${current.description}</p>`;
  document.getElementById("pComp").innerHTML = `<p>${current.composition}</p>`;
  document.getElementById("pSize").innerHTML = `<p>${current.sizing}</p>`;

  document.getElementById("pThumbs").innerHTML = current.images.map((img, i) =>
    `<button class="${i === 0 ? "on" : ""}" data-img="${img}" aria-label="View image ${i + 1}">
       <img src="${img}" alt=""></button>`).join("");

  document.getElementById("pSizes").innerHTML = current.sizes.map(s =>
    `<button data-size="${s}">${s}</button>`).join("");

  const add = document.getElementById("pAdd");
  add.disabled = true;
  add.textContent = "Select a size";

  document.getElementById("panel").classList.add("open");
  document.body.style.overflow = "hidden";
  document.getElementById("panel").scrollTop = 0;
}

function closeProduct() {
  document.getElementById("panel").classList.remove("open");
  document.body.style.overflow = "";
}

/* ── cart ── */
function renderCart() {
  const box = document.getElementById("cartItems");
  const count = document.getElementById("cartCount");
  const btn = document.getElementById("checkout");

  if (!cart.length) {
    box.innerHTML = `<div class="cart-empty">Your bag is empty.<br>Every piece is cut after you order.</div>`;
    document.getElementById("cartTotal").textContent = "€0";
    count.classList.remove("on");
    btn.disabled = true;
    return;
  }

  box.innerHTML = cart.map((it, i) => `
    <div class="ci">
      <div class="ci-img"><img src="${it.img}" alt=""></div>
      <div>
        <h4>${it.name}</h4>
        <div class="meta">Size ${it.size}</div>
        <button class="rm" data-rm="${i}">Remove</button>
      </div>
      <div class="ci-price">${money(it.price)}</div>
    </div>`).join("");

  document.getElementById("cartTotal").textContent =
    money(cart.reduce((s, i) => s + i.price, 0));
  count.textContent = cart.length;
  count.classList.add("on");
  btn.disabled = false;
}

const openCart = () => {
  document.getElementById("cart").classList.add("open");
  document.getElementById("scrim").classList.add("open");
  document.body.style.overflow = "hidden";
};
const closeAll = () => {
  document.getElementById("cart").classList.remove("open");
  document.getElementById("menu").classList.remove("open");
  document.getElementById("scrim").classList.remove("open");
  if (!document.getElementById("panel").classList.contains("open"))
    document.body.style.overflow = "";
};

/* ── checkout ── */
function checkout() {
  // Single item with a Stripe link → go straight to Stripe.
  if (cart.length === 1 && cart[0].stripe) {
    window.location.href = cart[0].stripe;
    return;
  }
  // Otherwise send an order request by email.
  const lines = cart.map(i => `· ${i.name} — size ${i.size} — ${money(i.price)}`).join("\n");
  const total = money(cart.reduce((s, i) => s + i.price, 0));
  const body =
    `I'd like to order:\n\n${lines}\n\nTotal: ${total}\n\n` +
    `Name:\nShipping address:\nNotes (measurements, questions):\n`;
  window.location.href =
    `mailto:${EMAIL}?subject=${encodeURIComponent("Order request")}&body=${encodeURIComponent(body)}`;
}

/* ── events ── */
document.addEventListener("click", e => {
  const card = e.target.closest(".card");
  if (card) return openProduct(card.dataset.id);

  const thumb = e.target.closest("[data-img]");
  if (thumb) {
    document.getElementById("pMain").src = thumb.dataset.img;
    document.querySelectorAll("#pThumbs button").forEach(b => b.classList.remove("on"));
    thumb.classList.add("on");
    return;
  }

  const size = e.target.closest("[data-size]");
  if (size) {
    currentSize = size.dataset.size;
    document.querySelectorAll("#pSizes button").forEach(b => b.classList.remove("on"));
    size.classList.add("on");
    const add = document.getElementById("pAdd");
    add.disabled = false;
    add.textContent = "Add to bag";
    return;
  }

  const rm = e.target.closest("[data-rm]");
  if (rm) {
    cart.splice(+rm.dataset.rm, 1);
    renderCart();
    return;
  }

  const f = e.target.closest("[data-f]");
  if (f) {
    filter = f.dataset.f;
    document.querySelectorAll(".filters button").forEach(b =>
      b.classList.toggle("on", b.dataset.f === filter));
    renderGrid();
    closeAll();
    return;
  }

  const acc = e.target.closest(".acc-t");
  if (acc) {
    const wrap = acc.parentElement;
    const panel = wrap.querySelector(".acc-p");
    const open = wrap.classList.toggle("on");
    panel.style.maxHeight = open ? panel.scrollHeight + "px" : "0";
    return;
  }
});

document.getElementById("pAdd").addEventListener("click", () => {
  if (!currentSize) return;
  cart.push({
    name: current.name,
    size: currentSize,
    price: current.price,
    img: current.images[0],
    stripe: current.stripe
  });
  renderCart();
  closeProduct();
  openCart();
});

document.getElementById("panelClose").addEventListener("click", closeProduct);
document.getElementById("cartOpen").addEventListener("click", openCart);
document.getElementById("cartClose").addEventListener("click", closeAll);
document.getElementById("scrim").addEventListener("click", closeAll);
document.getElementById("checkout").addEventListener("click", checkout);
document.getElementById("menuOpen").addEventListener("click", () => {
  document.getElementById("menu").classList.add("open");
  document.getElementById("scrim").classList.add("open");
  document.body.style.overflow = "hidden";
});
document.getElementById("menuClose").addEventListener("click", closeAll);

document.addEventListener("keydown", e => {
  if (e.key === "Escape") { closeProduct(); closeAll(); }
});

async function boot() {
  const grid = document.getElementById("grid");
  grid.classList.add("is-empty");
  grid.innerHTML = `<div class="grid-empty"><span class="caps">Loading</span></div>`;
  try {
    const res = await fetch("/api/products");
    PRODUCTS = await res.json();
  } catch (e) {
    PRODUCTS = [];
  }
  renderGrid();
  renderCart();
}

boot();
