import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import "./App.css";

const API = import.meta.env.VITE_API_URL || "/api";
const ADMIN_PATH =
  import.meta.env.VITE_ADMIN_BASE_PATH || "/private-cafe-console";
const MENU_CACHE_KEY = "ccb-menu-cache-v2";
const MENU_CACHE_INVALIDATION_KEY = "ccb-menu-cache-invalidated";
const MENU_CACHE_TTL = 2 * 60 * 1000;
const readMenuCache = () => {
  try {
    const cached = JSON.parse(localStorage.getItem(MENU_CACHE_KEY) || "null");
    return cached && Array.isArray(cached.items) ? cached : null;
  } catch {
    return null;
  }
};
const writeMenuCache = (items, etag) => {
  try {
    localStorage.setItem(
      MENU_CACHE_KEY,
      JSON.stringify({
        items,
        etag: etag || null,
        expiresAt: Date.now() + MENU_CACHE_TTL,
      }),
    );
  } catch {
    // Menu loading still works when browser storage is unavailable or full.
  }
};
const invalidateMenuCache = () => {
  try {
    localStorage.removeItem(MENU_CACHE_KEY);
    localStorage.setItem(MENU_CACHE_INVALIDATION_KEY, String(Date.now()));
  } catch {
    // The server cache is still invalidated by the admin API.
  }
};
const loadCachedMenu = async ({ force = false } = {}) => {
  const cached = readMenuCache();
  if (!force && cached && cached.expiresAt > Date.now()) return cached.items;
  const response = await fetch(`${API}/menu`, {
    cache: "no-cache",
    headers: cached?.etag ? { "If-None-Match": cached.etag } : undefined,
  });
  if (response.status === 304 && cached) {
    writeMenuCache(cached.items, cached.etag);
    return cached.items;
  }
  if (!response.ok) throw new Error("Menu unavailable");
  const items = await response.json();
  writeMenuCache(items, response.headers.get("ETag"));
  return items;
};
const money = (value) => `₹${Number(value).toLocaleString("en-IN")}`;
const loadRazorpay = () =>
  new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = resolve;
    script.onerror = () =>
      reject(
        new Error(
          "Unable to load Razorpay Checkout. Check your connection and try again.",
        ),
      );
    document.body.appendChild(script);
  });
const waitForPayment = async (reference) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const response = await fetch(`${API}/payment/status/${reference}`);
    const data = await response.json();
    if (data.status === "PAID") return data;
    if (data.status === "FAILED")
      throw new Error("Payment failed. Your cart is still saved.");
  }
  throw new Error(
    "Payment is still being confirmed. Please check your receipt again shortly.",
  );
};
const getRoute = () =>
  window.location.pathname === "/cigarettes"
    ? "cigarettes"
    : window.location.pathname === "/menu"
    ? "menu"
    : window.location.pathname === "/checkout"
      ? "checkout"
      : window.location.pathname === "/success"
        ? "success"
        : "home";
const isCartRoute = () =>
  new URLSearchParams(window.location.search).get("cart") === "1";
const readStoredReceipt = () => {
  try {
    return JSON.parse(sessionStorage.getItem("ccb-receipt") || "null");
  } catch {
    return null;
  }
};
function Spinner({ className = "" }) {
  return <span className={`loading-spinner ${className}`} aria-hidden="true" />;
}

function App() {
  const [menu, setMenu] = useState([]),
    [category, setCategory] = useState(
      () => {
        const stored = localStorage.getItem("ccb-category");
        return stored && stored !== "Breakfast" ? stored : "Cold Beverages";
      },
    );
  const [cart, setCart] = useState(() =>
    JSON.parse(localStorage.getItem("ccb-cart") || "[]"),
  );
  const initialRoute = getRoute();
  const [view, setView] = useState(
      initialRoute === "menu"
        ? "menu"
        : initialRoute === "cigarettes"
          ? "cigarettes"
        : initialRoute === "success"
          ? "success"
          : "home",
    ),
    [showCart, setShowCart] = useState(isCartRoute()),
    [checkout, setCheckout] = useState(initialRoute === "checkout");
  const [phone, setPhone] = useState(""),
    [tableNumber, setTableNumber] = useState(""),
    [notice, setNotice] = useState(""),
    [receipt, setReceipt] = useState(readStoredReceipt),
    [paying, setPaying] = useState(false),
    [paymentStage, setPaymentStage] = useState(""),
    [paymentOptions, setPaymentOptions] = useState(null),
    [paymentMethod, setPaymentMethod] = useState("");
  const [menuLoading, setMenuLoading] = useState(true);
  const [showIntro, setShowIntro] = useState(
    !window.location.pathname.startsWith(ADMIN_PATH),
  );
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, []);
  const navigate = (path) => {
    setPaymentOptions(null);
    setPaymentMethod("");
    window.history.pushState({}, "", path);
    const route = getRoute();
    setView(
      route === "menu"
        ? "menu"
        : route === "cigarettes"
          ? "cigarettes"
          : route === "success"
            ? "success"
            : "home",
    );
    setCheckout(route === "checkout");
    setShowCart(isCartRoute());
    window.scrollTo(0, 0);
  };
  const openCart = () => {
    if (isCartRoute()) return setShowCart(true);
    window.history.pushState({}, "", `${window.location.pathname}?cart=1`);
    setShowCart(true);
  };
  const closeCart = () => {
    if (isCartRoute()) window.history.back();
    else setShowCart(false);
  };
  useEffect(() => {
    const onPopState = () => {
      const route = getRoute();
      setView(
        route === "menu"
          ? "menu"
          : route === "cigarettes"
            ? "cigarettes"
            : route === "success"
              ? "success"
              : "home",
      );
      setCheckout(route === "checkout");
      setShowCart(isCartRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    loadCachedMenu()
      .then(setMenu)
      .catch(() => {})
      .finally(() => setMenuLoading(false));
  }, []);
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== MENU_CACHE_INVALIDATION_KEY) return;
      loadCachedMenu({ force: true }).then(setMenu).catch(() => {});
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(
    () => localStorage.setItem("ccb-cart", JSON.stringify(cart)),
    [cart],
  );
  useEffect(() => localStorage.setItem("ccb-category", category), [category]);
  useEffect(() => {
    if (!showIntro) return undefined;
    const timer = window.setTimeout(() => setShowIntro(false), 3400);
    return () => window.clearTimeout(timer);
  }, [showIntro]);
  const mainMenu = menu.filter((item) => item.category !== "Cigarettes"),
    categories = [...new Set(mainMenu.map((i) => i.category))],
    cartCount = cart.reduce((s, i) => s + i.quantity, 0),
    total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const updateCart = (item, delta) =>
    setCart((current) => {
      const found = current.find((i) => i.id === item.id);
      if (!found && delta > 0) return [...current, { ...item, quantity: 1 }];
      return current
        .map((i) =>
          i.id === item.id ? { ...i, quantity: i.quantity + delta } : i,
        )
        .filter((i) => i.quantity > 0);
    });
  const updateCheckoutPhone = (value) => {
    setPhone(value);
    setPaymentOptions(null);
    setPaymentMethod("");
  };
  const updateCheckoutTable = (value) => {
    setTableNumber(value);
    setPaymentOptions(null);
    setPaymentMethod("");
  };
  const placeOrder = async (e) => {
    e.preventDefault();
    if (!/^\d{10}$/.test(phone.replace(/\D/g, "")))
      return setNotice("Please enter a valid 10-digit mobile number.");
    const requiresTable = cart.some((item) => item.category !== "Cigarettes");
    if (requiresTable && !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,19}$/.test(tableNumber.trim()))
      return setNotice("Please enter your table number.");
    if (!paymentOptions) {
      setNotice("");
      setPaying(true);
      setPaymentStage("checking-khatta");
      try {
        const optionsResponse = await fetch(`${API}/payment/options`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone,
            tableNumber: requiresTable ? tableNumber.trim() : "",
            items: cart.map(({ id, quantity }) => ({ id, quantity })),
          }),
        });
        const options = await optionsResponse.json();
        if (!optionsResponse.ok) throw Error(options.error || "Unable to load payment options");
        setPaymentOptions(options);
      } catch (error) {
        setNotice(error.message);
      } finally {
        setPaying(false);
        setPaymentStage("");
      }
      return;
    }
    if (!paymentMethod || paymentMethod === "PAY_NOW") {
      return setNotice("Choose how you want to pay.");
    }
    setNotice("");
    setPaying(true);
    setPaymentStage("creating-order");
    const orderSource =
      new URLSearchParams(window.location.search).get("source") ===
      "cigarettes"
        ? "cigarettes"
        : "menu";
    try {
      const create = await fetch(`${API}/payment/create-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone,
          tableNumber: requiresTable ? tableNumber.trim() : "",
          paymentMethod,
          items: cart.map(({ id, quantity }) => ({ id, quantity })),
        }),
      });
      const paymentOrder = await create.json();
      if (!create.ok)
        throw Error(paymentOrder.error || "Unable to start payment");
      if (paymentOrder.paymentMethod === "KHATTA" || paymentOrder.paymentMethod === "CASH") {
        sessionStorage.setItem("ccb-receipt", JSON.stringify(paymentOrder));
        setReceipt(paymentOrder);
        setCart([]);
        setTableNumber("");
        setPaymentOptions(null);
        setPaymentMethod("");
        setPaying(false);
        setPaymentStage("");
        navigate(`/success?source=${orderSource}`);
        return;
      }
      setPaymentStage("opening-payment");
      await loadRazorpay();
      const options = {
        key: paymentOrder.keyId,
        amount: paymentOrder.amount,
        currency: paymentOrder.currency,
        name: "Cafe Coffee Bar 3.0",
        description: "Cafe order",
        order_id: paymentOrder.razorpayOrderId,
        prefill: { contact: phone },
        theme: { color: "#10264a" },
        handler: async (response) => {
          try {
            setPaymentStage("confirming-payment");
            const verify = await fetch(`${API}/payment/verify`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...response,
                reference: paymentOrder.reference,
              }),
            });
            let data = await verify.json();
            if (verify.status === 202)
              data = await waitForPayment(paymentOrder.reference);
            if (!verify.ok && data.status !== "PAID")
              throw Error(data.error || "Payment verification failed");
            sessionStorage.setItem("ccb-receipt", JSON.stringify(data));
            setReceipt(data);
            setCart([]);
            setTableNumber("");
            navigate(`/success?source=${orderSource}`);
          } catch (error) {
            setNotice(error.message);
          } finally {
            setPaying(false);
            setPaymentStage("");
          }
        },
        modal: {
          ondismiss: () => {
            setNotice("Payment cancelled. Your cart is still saved.");
            setPaying(false);
            setPaymentStage("");
          },
        },
      };
      const razorpay = new window.Razorpay(options);
      razorpay.on("payment.failed", (response) => {
        setNotice(
          response.error?.description ||
            "Payment could not be completed. Your cart is still saved.",
        );
        setPaying(false);
        setPaymentStage("");
      });
      razorpay.open();
    } catch (error) {
      setNotice(error.message);
      setPaying(false);
      setPaymentStage("");
    }
  };
  if (window.location.pathname.startsWith(ADMIN_PATH)) return <AdminApp />;
  if (view === "success" && receipt)
    return (
      <Success
        receipt={receipt}
        onMenu={() =>
          navigate(
            new URLSearchParams(window.location.search).get("source") ===
              "cigarettes"
              ? "/cigarettes"
              : "/menu",
          )
        }
      />
    );
  if (checkout)
    return (
      <Checkout
        cart={cart}
        total={total}
        phone={phone}
        setPhone={updateCheckoutPhone}
        tableNumber={tableNumber}
        setTableNumber={updateCheckoutTable}
        requiresTable={cart.some((item) => item.category !== "Cigarettes")}
        paymentOptions={paymentOptions}
        paymentMethod={paymentMethod}
        setPaymentMethod={setPaymentMethod}
        onSubmit={placeOrder}
        onBack={() =>
          navigate(
            new URLSearchParams(window.location.search).get("source") ===
              "cigarettes"
              ? "/cigarettes?cart=1"
              : "/menu?cart=1",
          )
        }
        notice={notice}
        paying={paying}
        paymentStage={paymentStage}
      />
    );
  return (
    <>
      <div className="app-shell">
      <header className="site-header">
        <button className="brand brand-button" onClick={() => navigate("/")}>
          <img
            className="brand-logo"
            src="/ccb-logo.jpg"
            alt="Cafe Coffee Bar 3.0 logo"
          />
          <span>
            <b>CAFÉ COFFEE BAR</b>
            <strong>3.0</strong>
          </span>
        </button>
        <nav>
          <button onClick={() => navigate("/")}>Home</button>
          {view !== "cigarettes" && <button onClick={() => navigate("/menu")}>Menu</button>}
          {view !== "home" && (
            <button className="outline-btn" onClick={openCart}>
              Cart <span>{cartCount}</span>
            </button>
          )}
        </nav>
      </header>
      {view === "home" ? (
        <main id="top">
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow">कॅफे कॉफी बार · KATRAJ, PUNE</p>
              <h1>
                Coffee, food &<br />
                <em>late-night cravings.</em>
              </h1>
              <p className="hero-text">
                A cozy neighbourhood café serving comfort food, cold coffees and
                good conversations.
              </p>
              <div className="hero-actions">
                <button className="gold-btn" onClick={() => navigate("/menu")}>
                  Order now <span>↗</span>
                </button>
                <button className="text-btn" onClick={() => navigate("/menu")}>
                  View full menu <span>↓</span>
                </button>
              </div>
              <div className="hero-note">
                <span>Open today</span>
                <b>8:00 AM — 11:30 PM</b>
              </div>
            </div>
            <div className="hero-art">
              <div className="hero-photo">
                <img
                  src="/cafe-exterior.png"
                  alt="Cafe Coffee Bar 3.0 exterior"
                />
                <div className="photo-label">
                  YOUR LOCAL
                  <br />
                  <b>COFFEE STOP</b>
                </div>
              </div>
              <div className="stamp">
                EST.
                <br />
                <b>3.0</b>
                <br />
                KATRAJ
              </div>
            </div>
          </section>
          <section className="home-menu">
            <div className="section-heading">
              <div>
                <p className="eyebrow">MADE FOR YOUR MOOD</p>
                <h2>
                  What are you
                  <br />
                  <em>in the mood for?</em>
                </h2>
              </div>
              <button className="text-btn" onClick={() => navigate("/menu")}>
                See all items ↗
              </button>
            </div>
            <div className="mood-grid">
              <MoodCard
                icon="☕"
                title="Start slow"
                text="Chai, coffee & cold beverages"
                onClick={() => {
                  setCategory("Cold Beverages");
                  navigate("/menu");
                }}
              />
              <MoodCard
                icon="✦"
                title="Stay awhile"
                text="Combos for good company"
                onClick={() => {
                  setCategory("Combos");
                  navigate("/menu");
                }}
              />
              <MoodCard
                icon="↗"
                title="Order ahead"
                text="Skip the wait at the counter"
                onClick={() => navigate("/menu")}
              />
            </div>
          </section>
        </main>
      ) : view === "cigarettes" ? (
        <CigarettesMenu
          menu={menu}
          loading={menuLoading}
          updateCart={updateCart}
          cart={cart}
        />
      ) : (
        <Menu
          menu={mainMenu}
          loading={menuLoading}
          category={category}
          categories={categories}
          setCategory={setCategory}
          updateCart={updateCart}
          cart={cart}
        />
      )}{" "}
      {view !== "home" && cartCount > 0 && (
        <button className="sticky-cart" onClick={openCart}>
          <span>
            🛒 {cartCount} {cartCount === 1 ? "item" : "items"}
          </span>
          <b>
            {money(total)} <i>→</i>
          </b>
        </button>
      )}
      {showCart && (
        <Cart
          cart={cart}
          total={total}
          updateCart={updateCart}
          onClose={closeCart}
          onCheckout={() =>
            navigate(view === "cigarettes" ? "/checkout?source=cigarettes" : "/checkout")
          }
        />
      )}
      <footer>
        <span>© CAFE COFFEE BAR 3.0</span>
        <a
          className="location-link"
          href="https://www.google.com/maps/place/Cafe+Coffee+Bar+-+3.0/@18.4588281,73.8583107,17z/data=!4m17!1m10!3m9!1s0x3bc2eb164e3ba65d:0x4e48e3045927b270!2sCafe+Coffee+Bar+-+3.0!8m2!3d18.4589142!4d73.85857!10e5!14m1!1BCgIgARICCAI!16s%2Fg%2F11z939yyp5!3m5!1s0x3bc2eb164e3ba65d:0x4e48e3045927b270!8m2!3d18.4589142!4d73.85857!16s%2Fg%2F11z939yyp5?entry=ttu&g_ep=EgoyMDI2MDkyMC4wIKXMDSoASAFQAw%3D%3D"
          target="_blank"
          rel="noreferrer"
        >
          Kadam Plaza · Bharati Vidyapeeth · Pune · <br />Get directions ↗
        </a>
        <span>Made for slow mornings & good nights.</span>
      </footer>
      </div>
      {showIntro && <IntroSplash />}
    </>
  );
}
function IntroSplash() {
  return (
    <div className="intro-splash" aria-hidden="true">
      <img className="intro-logo" src="/ccb-logo.jpg" alt="" />
    </div>
  );
}
function MoodCard({ icon, title, text, onClick }) {
  return (
    <button className="mood-card" onClick={onClick}>
      <span className="mood-icon">{icon}</span>
      <span>
        <b>{title}</b>
        <small>{text}</small>
      </span>
      <i>↗</i>
    </button>
  );
}
function Menu({ menu, loading, category, categories, setCategory, updateCart, cart }) {
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [category]);
  if (loading) {
    return (
      <main className="menu-page menu-loading" role="status">
        <Spinner className="large-spinner" />
        <p>Loading the menu…</p>
      </main>
    );
  }
  return (
    <main className={`menu-page ${category === "Combos" ? "combos-page" : ""}`}>
      <div className="menu-intro">
        <div>
          <p className="eyebrow">THE DIGITAL MENU</p>
          <h1>
            Pick your
            <br />
            <em>perfect bite.</em>
          </h1>
        </div>
        <p>Freshly made, fairly priced, always served with a little warmth.</p>
      </div>
      <div className="category-sticky">
        <div className="category-tabs">
          {categories.map((name) => (
            <button
              className={name === category ? "active" : ""}
              key={name}
              onClick={() => setCategory(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className="menu-grid">
        {menu
          .filter((i) => i.category === category)
          .map((item) => {
            const qty = cart.find((i) => i.id === item.id)?.quantity || 0;
            return (
              <article
                className={`menu-item ${item.category === "Combos" ? "combo-item" : "compact-item"} ${!item.available ? "sold-out" : ""}`}
                key={item.id}
              >
                <div>
                  <p className="item-category">{item.category}</p>
                  <h3>{item.name}</h3>
                  <p>{item.description}</p>
                </div>
                <div className="item-buy">
                  <strong>{money(item.price)}</strong>
                  {item.available ? (
                    qty ? (
                      <div className="quantity">
                        <button onClick={() => updateCart(item, -1)}>−</button>
                        <b>{qty}</b>
                        <button onClick={() => updateCart(item, 1)}>+</button>
                      </div>
                    ) : (
                      <button
                        className="add-btn"
                        onClick={() => updateCart(item, 1)}
                      >
                        Add <span>+</span>
                      </button>
                    )
                  ) : (
                    <span className="sold-label">SOLD OUT</span>
                  )}
                </div>
              </article>
            );
          })}
      </div>
    </main>
  );
}
function CigarettesMenu({ menu, loading, updateCart, cart }) {
  const [search, setSearch] = useState("");
  const cigaretteMenu = menu.filter((item) => item.category === "Cigarettes");
  const visibleMenu = cigaretteMenu.filter((item) =>
    item.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  if (loading) {
    return (
      <main className="menu-page menu-loading" role="status">
        <Spinner className="large-spinner" />
        <p>Loading the cigarette menu…</p>
      </main>
    );
  }
  return (
    <main className="menu-page cigarettes-page">
      <div className="menu-intro">
        <div>
          <p className="eyebrow">PRIVATE CIGARETTE MENU</p>
          <h1>
            Choose your
            <br />
            <em>pack-up.</em>
          </h1>
        </div>
        <p>Available individually. Add your selection to the cart and pay securely online.</p>
      </div>
      <label className="cigarette-search">
        <span>Find a cigarette</span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name"
          aria-label="Search cigarettes"
        />
      </label>
      <div className="menu-grid">
        {visibleMenu.map((item) => {
          const qty = cart.find((cartItem) => cartItem.id === item.id)?.quantity || 0;
          return (
            <article className="menu-item compact-item" key={item.id}>
              <div>
                <p className="item-category">Cigarettes</p>
                <h3>{item.name}</h3>
                <p>{item.description}</p>
              </div>
              <div className="item-buy">
                <strong>{money(item.price)}</strong>
                {qty ? (
                  <div className="quantity">
                    <button onClick={() => updateCart(item, -1)}>−</button>
                    <b>{qty}</b>
                    <button onClick={() => updateCart(item, 1)}>+</button>
                  </div>
                ) : (
                  <button className="add-btn" onClick={() => updateCart(item, 1)}>
                    Add <span>+</span>
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!visibleMenu.length && (
        <p className="empty-state">No cigarettes match your search.</p>
      )}
    </main>
  );
}
function Cart({ cart, total, updateCart, onClose, onCheckout }) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="cart-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <p className="eyebrow">YOUR ORDER</p>
            <h2>Good choices.</h2>
          </div>
          <button onClick={onClose}>×</button>
        </div>
        <div className="cart-lines">
          {cart.map((item) => (
            <div className="cart-line" key={item.id}>
              <div>
                <b>{item.name}</b>
                <small>
                  {item.quantity} × {money(item.price)}
                </small>
              </div>
              <strong>{money(item.quantity * item.price)}</strong>
              <div className="quantity">
                <button onClick={() => updateCart(item, -1)}>−</button>
                <b>{item.quantity}</b>
                <button onClick={() => updateCart(item, 1)}>+</button>
              </div>
            </div>
          ))}
        </div>
        <div className="cart-total">
          <span>Total to pay</span>
          <strong>{money(total)}</strong>
        </div>
        <button className="gold-btn full" onClick={onCheckout}>
          Proceed to checkout <span>→</span>
        </button>
        <p className="secure-note">
          Guest checkout · secure payment · pay first policy
        </p>
      </aside>
    </div>
  );
}
function Checkout({
  cart,
  total,
  phone,
  setPhone,
  tableNumber,
  setTableNumber,
  requiresTable,
  paymentOptions,
  paymentMethod,
  setPaymentMethod,
  onSubmit,
  onBack,
  notice,
  paying,
  paymentStage,
}) {
  return (
    <div className="checkout-page">
      <button className="back-btn" onClick={onBack}>
        ← Back to cart
      </button>
      <div className="checkout-wrap">
        <div className="checkout-copy">
          <p className="eyebrow">ONE LAST STEP</p>
          <h1>
            Almost
            <br />
            <em>there.</em>
          </h1>
          <p>
            Enter your mobile number for the payment confirmation and digital
            receipt.
          </p>
          <div className="checkout-badge">
            <img src="/ccb-logo.jpg" alt="Cafe Coffee Bar 3.0 logo" />
            <span>
              <b>CAFE COFFEE BAR</b> <strong>3.0</strong>
              <br />
              <small>Katraj, Pune</small>
            </span>
          </div>
        </div>
        <form className="checkout-card" onSubmit={onSubmit}>
          <p className="eyebrow">ORDER SUMMARY</p>
          {cart.map((item) => (
            <div className="summary-row" key={item.id}>
              <span>
                {item.name} <small>× {item.quantity}</small>
              </span>
              <b>{money(item.price * item.quantity)}</b>
            </div>
          ))}
          <div className="summary-total">
            <span>Total</span>
            <strong>{money(total)}</strong>
          </div>
          <label htmlFor="phone">Mobile number</label>
          <div className="phone-input">
            <span>+91</span>
            <input
              id="phone"
              value={phone}
              onChange={(e) =>
                setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))
              }
              placeholder="10-digit number"
              inputMode="numeric"
              required
            />
          </div>
          {paying && paymentStage === "checking-khatta" && (
            <p className="field-loading" role="status">
              <Spinner /> Checking your payment options…
            </p>
          )}
          {requiresTable && (
            <>
              <label htmlFor="table-number">Table number</label>
              <input
                id="table-number"
                className="table-input"
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value.slice(0, 20))}
                placeholder="For example, 5 or A2"
                autoComplete="off"
                required
              />
            </>
          )}
          {paymentOptions && (
            <div className="payment-options">
              <p className="eyebrow">PAYMENT METHOD</p>
              {paymentOptions.khattaEligible && !paymentMethod && (
                <div className="payment-choice-grid">
                  <button type="button" className="payment-choice" onClick={() => setPaymentMethod("KHATTA")} disabled={paying}>
                    <b>Put in Khatta</b>
                    <small>Settle with the owner later</small>
                  </button>
                  <button type="button" className="payment-choice" onClick={() => setPaymentMethod("PAY_NOW")} disabled={paying}>
                    <b>Pay right now</b>
                    <small>Choose cash or online</small>
                  </button>
                </div>
              )}
              {(!paymentOptions.khattaEligible || paymentMethod === "PAY_NOW") && (
                <div className="payment-choice-grid">
                  {paymentOptions.khattaEligible && (
                    <button type="button" className="payment-back" onClick={() => setPaymentMethod("")} disabled={paying}>
                      ← Back
                    </button>
                  )}
                  <button type="button" className="payment-choice" onClick={() => setPaymentMethod("CASH")} disabled={paying}>
                    <b>Pay with cash</b>
                    <small>Pay at the counter</small>
                  </button>
                  <button type="button" className="payment-choice" onClick={() => setPaymentMethod("ONLINE")} disabled={paying}>
                    <b>Pay online</b>
                    <small>Secure Razorpay payment</small>
                  </button>
                </div>
              )}
              {paymentMethod && paymentMethod !== "PAY_NOW" && (
                <p className="selected-payment">
                  Selected: <b>{paymentMethod === "KHATTA" ? "Khatta" : paymentMethod === "CASH" ? "Cash" : "Online"}</b>
                  <button type="button" onClick={() => setPaymentMethod("")} disabled={paying}>Change</button>
                </p>
              )}
            </div>
          )}
          {notice && <p className="form-error">{notice}</p>}
          <button className="gold-btn full" type="submit" disabled={paying}>
            {paying ? <><Spinner className="button-spinner" /> {paymentStage === "checking-khatta" ? "Checking number…" : paymentStage === "creating-order" ? "Preparing order…" : paymentStage === "opening-payment" ? "Opening secure payment…" : paymentStage === "confirming-payment" ? "Confirming payment…" : "Processing…"}</> : !paymentOptions ? "Continue" : paymentMethod === "KHATTA" ? "Add to Khatta" : paymentMethod === "CASH" ? "Place cash order" : paymentMethod === "ONLINE" ? <>Pay {money(total)} <span>→</span></> : "Choose payment method"}
          </button>
          <p className="secure-note">
            {paymentMethod === "CASH" ? "Cash payment is confirmed by staff after collection" : "Payment method is confirmed by the server"}
          </p>
        </form>
      </div>
      {paying && paymentStage === "confirming-payment" && (
        <div className="payment-processing" role="status" aria-live="polite">
          <div className="processing-card">
            <Spinner className="large-spinner" />
            <strong>Confirming your payment</strong>
            <p>Please wait while we prepare your order and digital bill.</p>
          </div>
        </div>
      )}
    </div>
  );
}
function Success({ receipt, onMenu }) {
  const khattaOrder = receipt.paymentStatus === "KHATTA";
  const cashOrder = receipt.paymentStatus === "CASH";
  const [openingBill, setOpeningBill] = useState(false);
  const openBill = () => {
    setOpeningBill(true);
    const billWindow = window.open(`${API}/receipts/${receipt.reference}`, "_blank");
    if (!billWindow) {
      setOpeningBill(false);
      return;
    }
    window.setTimeout(() => setOpeningBill(false), 1200);
  };
  return (
    <div className="success-page">
      <div className="success-card">
        <div className="success-icon">✓</div>
        <p className="eyebrow">{khattaOrder || cashOrder ? "ORDER CONFIRMED" : "PAYMENT SUCCESSFUL"}</p>
        <h1>
          Thank you for
          <br />
          <em>ordering in.</em>
        </h1>
        <p className="success-message">
          {cashOrder ? "Your order is confirmed. Please pay cash at the counter." : "Your order is confirmed and your digital receipt is ready."}
        </p>
        <div className="receipt-preview">
          <span>
            ORDER <b>{receipt.orderNumber}</b>
          </span>
          <span>
            {khattaOrder || cashOrder ? "ORDER TOTAL" : "AMOUNT PAID"} <b>{money(receipt.total)}</b>
          </span>
          <span>
            MOBILE <b>+91 {receipt.phone}</b>
          </span>
          {receipt.tableNumber && (
            <span>
              TABLE <b>{receipt.tableNumber}</b>
            </span>
          )}
        </div>
        <button
          className="gold-btn full"
          onClick={openBill}
          disabled={openingBill}
        >
          {openingBill ? <><Spinner className="button-spinner" /> Opening digital bill…</> : <>View digital bill <span>↗</span></>}
        </button>
        <button className="text-btn" onClick={onMenu}>
          Back to menu
        </button>
      </div>
    </div>
  );
}
const ADMIN_ROUTES = ["order", "cash-order", "menu", "khatta"];
const readAdminRoute = () => {
  const route = window.location.pathname
    .slice(ADMIN_PATH.length)
    .replace(/^\/+|\/+$/g, "");
  return ADMIN_ROUTES.includes(route) ? route : "order";
};

function AdminApp() {
  const adminApi = `${ADMIN_PATH}/api`;
  const [adminRoute, setAdminRoute] = useState(readAdminRoute);
  const [loggedIn, setLoggedIn] = useState(false),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [loginLoading, setLoginLoading] = useState(false),
    [menuSaving, setMenuSaving] = useState(false),
    [menuDeleting, setMenuDeleting] = useState(null),
    [khattaSaving, setKhattaSaving] = useState(false);
  const [orders, setOrders] = useState([]),
    [menu, setMenu] = useState([]),
    [form, setForm] = useState({
      id: "",
      name: "",
      category: "",
      description: "",
      price: "",
    }),
    [message, setMessage] = useState(""),
    [editingId, setEditingId] = useState(null),
    [orderSearch, setOrderSearch] = useState(""),
    [cashConfirming, setCashConfirming] = useState(null),
    [khattaUsers, setKhattaUsers] = useState([]),
    [khattaForm, setKhattaForm] = useState({ name: "", phone: "" }),
    [khattaSearch, setKhattaSearch] = useState(""),
    [khattaMessage, setKhattaMessage] = useState(""),
    [khattaBusy, setKhattaBusy] = useState(null),
    [cashOrderCart, setCashOrderCart] = useState([]),
    [cashOrderSearch, setCashOrderSearch] = useState(""),
    [cashOrderPhone, setCashOrderPhone] = useState(""),
    [cashOrderTable, setCashOrderTable] = useState(""),
    [cashOrderMessage, setCashOrderMessage] = useState(""),
    [cashOrderSaving, setCashOrderSaving] = useState(false);
  useEffect(() => {
    const rawRoute = window.location.pathname
      .slice(ADMIN_PATH.length)
      .replace(/^\/+|\/+$/g, "");
    if (window.location.pathname === ADMIN_PATH || !ADMIN_ROUTES.includes(rawRoute)) {
      window.history.replaceState({}, "", `${ADMIN_PATH}/order`);
    }
    const onPopState = () => setAdminRoute(readAdminRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigateAdmin = (route) => {
    window.history.pushState({}, "", `${ADMIN_PATH}/${route}`);
    setAdminRoute(route);
    window.scrollTo(0, 0);
  };
  const load = useCallback(async () => {
    try {
      const ordersResponse = await fetch(`${adminApi}/orders`, {
        credentials: "include",
      });
      if (!ordersResponse.ok) {
        if (ordersResponse.status === 401) setLoggedIn(false);
        return;
      }
      setOrders(await ordersResponse.json());
      setLoggedIn(true);
      const menuResponse = await fetch(`${adminApi}/menu`, {
        credentials: "include",
        cache: "no-store",
      });
      if (menuResponse.ok) setMenu(await menuResponse.json());
      const khattaResponse = await fetch(`${adminApi}/khatta/users`, {
        credentials: "include",
      });
      if (khattaResponse.ok) setKhattaUsers(await khattaResponse.json());
    } catch {
      setError("Unable to connect to the admin server");
    }
  }, [adminApi]);
  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (!loggedIn) return undefined;
    const stream = new EventSource(`${adminApi}/orders/stream`, {
      withCredentials: true,
    });
    stream.addEventListener("order-created", load);
    return () => stream.close();
  }, [adminApi, load, loggedIn]);
  const login = async (e) => {
    e.preventDefault();
    setLoginLoading(true);
    try {
      const r = await fetch(`${adminApi}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) {
        setError("Invalid admin credentials");
        return;
      }
      setError("");
      load();
    } catch {
      setError("Unable to connect to the admin server");
    } finally {
      setLoginLoading(false);
    }
  };
  const saveDish = async (e) => {
    e.preventDefault();
    setMenuSaving(true);
    try {
      const r = await fetch(`${adminApi}/menu`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...form, price: Number(form.price) }),
      });
      if (r.ok) {
        setMessage(editingId ? "Dish updated" : "Dish added");
        setForm({
          id: "",
          name: "",
          category: "",
          description: "",
          price: "",
        });
        setEditingId(null);
        invalidateMenuCache();
        load();
      } else setMessage("Could not save dish");
    } catch {
      setMessage("Could not save dish");
    } finally {
      setMenuSaving(false);
    }
  };
  const editDish = (item) => {
    setForm({ ...item, price: String(item.price) });
    setEditingId(item.id);
    setMessage("Editing dish — save when ready");
  };
  const deleteDish = async (item) => {
    if (!window.confirm(`Remove ${item.name} from the menu?`)) return;
    setMenuDeleting(item.id);
    try {
      const r = await fetch(`${adminApi}/menu/${item.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (r.ok) {
        setMessage(`${item.name} removed`);
        if (editingId === item.id) {
          setEditingId(null);
          setForm({
            id: "",
            name: "",
            category: "Cold Beverages",
            description: "",
            price: "",
          });
        }
        invalidateMenuCache();
        load();
      } else setMessage("Could not remove dish");
    } catch {
      setMessage("Could not remove dish");
    } finally {
      setMenuDeleting(null);
      }
  };
  const confirmCashPayment = async (order) => {
    setCashConfirming(order.id);
    try {
      const response = await fetch(`${adminApi}/orders/${order.id}/confirm-cash`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Could not confirm cash payment");
      }
      await load();
    } catch (cashError) {
      setMessage(cashError.message);
    } finally {
      setCashConfirming(null);
    }
  };
  const updateCashOrderCart = (item, delta) => {
    setCashOrderCart((current) => {
      const found = current.find((entry) => entry.id === item.id);
      if (!found && delta > 0) return [...current, { ...item, quantity: 1 }];
      return current
        .map((entry) => entry.id === item.id ? { ...entry, quantity: entry.quantity + delta } : entry)
        .filter((entry) => entry.quantity > 0);
    });
  };
  const placeCashOrder = async (e) => {
    e.preventDefault();
    setCashOrderMessage("");
    if (!/^\d{10}$/.test(cashOrderPhone)) {
      setCashOrderMessage("Enter a valid 10-digit mobile number");
      return;
    }
    if (!cashOrderCart.length) {
      setCashOrderMessage("Add at least one item to the order");
      return;
    }
    const requiresTable = cashOrderCart.some((item) => item.category !== "Cigarettes");
    if (requiresTable && !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,19}$/.test(cashOrderTable.trim())) {
      setCashOrderMessage("Enter a valid table number for a food order");
      return;
    }
    setCashOrderSaving(true);
    try {
      const response = await fetch(`${adminApi}/cash-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          phone: cashOrderPhone,
          tableNumber: requiresTable ? cashOrderTable.trim() : "",
          items: cashOrderCart.map(({ id, quantity }) => ({ id, quantity })),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not place cash order");
      setCashOrderCart([]);
      setCashOrderPhone("");
      setCashOrderTable("");
      setCashOrderMessage(`${data.orderNumber} placed as cash order`);
      load();
    } catch (cashError) {
      setCashOrderMessage(cashError.message);
    } finally {
      setCashOrderSaving(false);
    }
  };
  const saveKhattaUser = async (e) => {
    e.preventDefault();
    setKhattaMessage("");
    setKhattaSaving(true);
    try {
      const response = await fetch(`${adminApi}/khatta/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(khattaForm),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setKhattaMessage(data.error || "Could not create Khatta customer");
        return;
      }
      setKhattaForm({ name: "", phone: "" });
      setKhattaMessage("Khatta customer created");
      load();
    } catch {
      setKhattaMessage("Could not create Khatta customer");
    } finally {
      setKhattaSaving(false);
    }
  };
  const settleKhatta = async (user) => {
    setKhattaBusy(user.id);
    setKhattaMessage("");
    try {
      const statementResponse = await fetch(
        `${adminApi}/khatta/users/${user.id}/statement`,
        { credentials: "include" },
      );
      const statement = await statementResponse.json();
      if (!statementResponse.ok)
        throw new Error(statement.error || "Could not create statement");
      const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const rows = [
        ["Customer", statement.user.name],
        ["Mobile", statement.user.phone],
        ["Total", statement.total],
        [],
        ["Order", "Date", "Items", "Amount"],
        ...statement.entries.map((entry) => [
          entry.order_number,
          new Date(entry.created_at).toLocaleString("en-IN"),
          entry.items
            .map((item) => `${item.quantity} x ${item.itemName}`)
            .join("; "),
          entry.amount,
        ]),
      ];
      const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      link.download = `khatta-${statement.user.phone}-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
      if (!window.confirm("The statement was downloaded. Clear this Khatta balance now?")) return;
      const password = window.prompt("Re-enter the admin password to clear this Khatta balance:");
      if (!password) return;
      const settleResponse = await fetch(
        `${adminApi}/khatta/users/${user.id}/settle`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            password,
            settlementToken: statement.settlementToken,
            downloadConfirmed: true,
          }),
        },
      );
      const result = await settleResponse.json().catch(() => ({}));
      if (!settleResponse.ok) throw new Error(result.error || "Could not clear Khatta balance");
      setKhattaMessage(`${user.name}'s Khatta balance was cleared`);
      load();
    } catch (settleError) {
      setKhattaMessage(settleError.message);
    } finally {
      setKhattaBusy(null);
    }
  };
  if (!loggedIn)
    return (
      <div className="admin-login">
        <div className="admin-login-card">
          <img
            className="admin-logo"
            src="/ccb-logo.jpg"
            alt="Cafe Coffee Bar 3.0 logo"
          />
          <p className="eyebrow">PRIVATE STAFF ACCESS</p>
          <h1>
            Welcome
            <br />
            <em>back.</em>
          </h1>
          <form onSubmit={login}>
            <label>
              Username
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="gold-btn full" disabled={loginLoading}>
              {loginLoading ? <><Spinner className="button-spinner" /> Signing in…</> : <>Enter dashboard <span>→</span></>}
            </button>
          </form>
          <p className="secure-note">Cafe Coffee Bar 3.0 · staff only</p>
        </div>
      </div>
    );
  const matchesOrderSearch = (order) => {
    const query = orderSearch.trim().toLowerCase();
    return !query || order.order_number.toLowerCase().includes(query) || String(order.table_number || "").toLowerCase().includes(query);
  };
  const pendingCashOrders = orders.filter((order) => order.payment_status === "CASH");
  const visibleOrders = orders.filter((order) => order.payment_status !== "CASH" && matchesOrderSearch(order));
  const visibleKhattaUsers = khattaUsers.filter((user) => {
    const query = khattaSearch.trim().toLowerCase();
    return !query || user.name.toLowerCase().includes(query) || user.phone.includes(query);
  });
  const cashOrderTotal = cashOrderCart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const cashOrderHasFood = cashOrderCart.some((item) => item.category !== "Cigarettes");
  const visibleCashMenu = menu.filter((item) => {
    const query = cashOrderSearch.trim().toLowerCase();
    return !query || item.name.toLowerCase().includes(query) || item.category.toLowerCase().includes(query);
  });
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="brand">
          <img
            className="brand-logo"
            src="/ccb-logo.jpg"
            alt="Cafe Coffee Bar 3.0 logo"
          />
          <span>
            <b>CAFE COFFEE BAR</b>
            <strong>3.0 / STAFF</strong>
          </span>
        </div>
        <nav className="admin-nav" aria-label="Admin sections">
          <button className={adminRoute === "order" ? "active" : ""} onClick={() => navigateAdmin("order")}>Orders</button>
          <button className={adminRoute === "cash-order" ? "active" : ""} onClick={() => navigateAdmin("cash-order")}>Cash order</button>
          <button className={adminRoute === "menu" ? "active" : ""} onClick={() => navigateAdmin("menu")}>Menu</button>
          <button className={adminRoute === "khatta" ? "active" : ""} onClick={() => navigateAdmin("khatta")}>Khatta</button>
        </nav>
        <button
          className="text-btn"
          onClick={async () => {
            await fetch(`${adminApi}/logout`, {
              method: "POST",
              credentials: "include",
            });
            setLoggedIn(false);
          }}
        >
          Sign out
        </button>
      </header>
      <main className="admin-main">
        <div className="admin-title">
          <div>
            <p className="eyebrow">PRIVATE ORDER DASHBOARD</p>
            <h1>
              Good morning,
              <br />
              <em>let's get moving.</em>
            </h1>
          </div>
          <span className="admin-date">
            {new Date().toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </span>
        </div>
        {adminRoute === "order" && (
          <section className="admin-section">
          <section className="admin-section pending-cash-section">
            <div className="admin-section-head">
              <div>
                <p className="eyebrow">CASH COLLECTION</p>
                <h2>Pending cash payments</h2>
              </div>
              <span className="active-count">{pendingCashOrders.length} pending</span>
            </div>
            <div className="orders-table">
              <div className="order-row order-head">
                <span>Order</span>
                <span>Items</span>
                <span>Mobile</span>
                <span>Table</span>
                <span>Total</span>
                <span>Action</span>
              </div>
              {pendingCashOrders.length ? (
                pendingCashOrders.map((o) => (
                  <div className="order-row" key={o.id}>
                    <span>
                      <b>{o.order_number}</b>
                      <small>{new Date(o.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</small>
                    </span>
                    <span className="order-items">
                      {o.items.map((i) => <span key={i.menuItemId}>{i.quantity} × {i.itemName}</span>)}
                    </span>
                    <span>+91 {o.phone}</span>
                    <span>{o.table_number || "—"}</span>
                    <span>{money(o.total)}</span>
                    <span>
                      <button className="confirm-cash-btn" type="button" onClick={() => confirmCashPayment(o)} disabled={cashConfirming === o.id}>
                        {cashConfirming === o.id ? <><Spinner /> Confirming…</> : "Confirm paid"}
                      </button>
                    </span>
                  </div>
                ))
              ) : (
                <p className="empty-state">No pending cash payments.</p>
              )}
            </div>
          </section>
          <section className="admin-section all-orders-section">
            <div className="admin-section-head">
              <div>
                <p className="eyebrow">ORDER HISTORY</p>
                <h2>All orders</h2>
              </div>
              <span className="active-count">{visibleOrders.length} orders</span>
            </div>
            <label className="order-search">
              Search orders
              <input
                type="search"
                value={orderSearch}
                onChange={(e) => setOrderSearch(e.target.value)}
                placeholder="Search by table number or order ID"
                aria-label="Search by table number or order ID"
              />
            </label>
            <div className="orders-table">
              <div className="order-row order-head">
                <span>Order</span>
                <span>Items</span>
                <span>Mobile</span>
                <span>Table</span>
                <span>Total</span>
                <span>Payment</span>
              </div>
              {visibleOrders.length ? (
                visibleOrders.map((o) => (
                  <div className="order-row" key={o.id}>
                    <span>
                      <b>{o.order_number}</b>
                      <small>
                        {new Date(o.createdAt).toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </small>
                    </span>
                    <span className="order-items">
                      {o.items.map((i) => (
                        <span key={i.menuItemId}>
                          {i.quantity} × {i.itemName}
                        </span>
                      ))}
                    </span>
                    <span>+91 {o.phone}</span>
                    <span>{o.table_number || "—"}</span>
                    <span>{money(o.total)}</span>
                    <span>
                      <b className="paid">{o.payment_status}</b>
                    </span>
                  </div>
                ))
              ) : (
                <p className="empty-state">No orders yet.</p>
              )}
            </div>
          </section>
        </section>
        )}
        {adminRoute === "cash-order" && (
          <section className="admin-section cash-order-section">
            <div className="admin-section-head">
              <div>
                <p className="eyebrow">STAFF ORDER ENTRY</p>
                <h2>Place cash order</h2>
              </div>
              <span className="active-count">No online payment</span>
            </div>
            <div className="cash-order-layout">
              <form className="cash-order-card" onSubmit={placeCashOrder}>
                <label>
                  Customer mobile number
                  <input
                    value={cashOrderPhone}
                    onChange={(e) => setCashOrderPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                    placeholder="10-digit number"
                    inputMode="numeric"
                    required
                  />
                </label>
                {cashOrderHasFood && (
                  <label>
                    Table number
                    <input
                      value={cashOrderTable}
                      onChange={(e) => setCashOrderTable(e.target.value.slice(0, 20))}
                      placeholder="For example, 5 or A2"
                      autoComplete="off"
                      required
                    />
                  </label>
                )}
                <div className="cash-order-summary">
                  <p className="eyebrow">ORDER SUMMARY</p>
                  {cashOrderCart.length ? cashOrderCart.map((item) => (
                    <div className="cash-summary-row" key={item.id}>
                      <span>{item.name} <small>× {item.quantity}</small></span>
                      <b>{money(item.price * item.quantity)}</b>
                    </div>
                  )) : <p className="empty-state">Select items to build the order.</p>}
                  <div className="cash-total"><span>Total</span><strong>{money(cashOrderTotal)}</strong></div>
                </div>
                {cashOrderMessage && <p className="form-success">{cashOrderMessage}</p>}
                <button className="gold-btn full" type="submit" disabled={cashOrderSaving}>
                  {cashOrderSaving ? <><Spinner className="button-spinner" /> Placing order…</> : <>Place cash order <span>₹{cashOrderTotal}</span></>}
                </button>
              </form>
              <div className="cash-menu-picker">
                <p className="eyebrow">LIVE MENU</p>
                <label className="cash-menu-search">
                  Search menu
                  <input
                    value={cashOrderSearch}
                    onChange={(e) => setCashOrderSearch(e.target.value)}
                    placeholder="Search item or category"
                  />
                </label>
                <div className="cash-menu-list">
                  {visibleCashMenu.map((item) => {
                    const selected = cashOrderCart.find((entry) => entry.id === item.id);
                    return (
                      <div className={`cash-menu-row ${!item.available ? "sold-out" : ""}`} key={item.id}>
                        <span><b>{item.name}</b><small>{item.category} · {money(item.price)}</small></span>
                        {selected ? (
                          <span className="quantity">
                            <button type="button" onClick={() => updateCashOrderCart(item, -1)}>−</button>
                            <b>{selected.quantity}</b>
                            <button type="button" onClick={() => updateCashOrderCart(item, 1)}>+</button>
                          </span>
                        ) : (
                          <button className="add-btn" type="button" disabled={!item.available} onClick={() => updateCashOrderCart(item, 1)}>{item.available ? "Add +" : "Sold out"}</button>
                        )}
                      </div>
                    );
                  })}
                  {!visibleCashMenu.length && <p className="empty-state">No matching menu items.</p>}
                </div>
              </div>
            </div>
          </section>
        )}
        {adminRoute === "khatta" && (
          <section className="admin-section khatta-section">
          <div className="admin-section-head">
            <div>
              <p className="eyebrow">PRIVATE CREDIT LEDGER</p>
              <h2>Khatta customers</h2>
            </div>
            <span className="active-count">{khattaUsers.length} active</span>
          </div>
          <label className="khatta-search">
            Search customer
            <input
              value={khattaSearch}
              onChange={(e) => setKhattaSearch(e.target.value)}
              placeholder="Name or mobile number"
            />
          </label>
          <form className="khatta-form" onSubmit={saveKhattaUser}>
            <input
              placeholder="Customer name"
              value={khattaForm.name}
              onChange={(e) => setKhattaForm({ ...khattaForm, name: e.target.value })}
              required
            />
            <input
              placeholder="10-digit mobile number"
              value={khattaForm.phone}
              onChange={(e) => setKhattaForm({ ...khattaForm, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
              inputMode="numeric"
              required
            />
            <button className="gold-btn" type="submit" disabled={khattaSaving}>
              {khattaSaving ? <><Spinner className="button-spinner" /> Adding…</> : <>Add customer <span>+</span></>}
            </button>
          </form>
          {khattaMessage && <p className="form-success">{khattaMessage}</p>}
          <div className="khatta-list">
            {visibleKhattaUsers.length ? visibleKhattaUsers.map((user) => (
              <div className="khatta-row" key={user.id}>
                <div>
                  <b>{user.name}</b>
                  <small>+91 {user.phone} · {user.entry_count} open order{Number(user.entry_count) === 1 ? "" : "s"}</small>
                </div>
                <strong>{money(user.balance)}</strong>
                <button className="settle-btn" type="button" onClick={() => settleKhatta(user)} disabled={khattaBusy === user.id || Number(user.balance) === 0}>
                  {khattaBusy === user.id ? <><Spinner /> Preparing…</> : "Download & settle"}
                </button>
              </div>
            )) : <p className="empty-state">{khattaUsers.length ? "No matching customers." : "No Khatta customers yet."}</p>}
          </div>
        </section>
        )}
        {adminRoute === "menu" && (
        <section className="admin-section menu-editor">
          <div className="admin-section-head">
            <div>
              <p className="eyebrow">MENU MANAGEMENT</p>
              <h2>{editingId ? "Edit dish" : "Add a dish"}</h2>
            </div>
            {editingId && (
              <button
                className="cancel-edit"
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm({
                    id: "",
                    name: "",
                    category: "Cold Beverages",
                    description: "",
                    price: "",
                  });
                  setMessage("");
                }}
              >
                Cancel edit
              </button>
            )}
          </div>
          <form className="dish-form" onSubmit={saveDish}>
            <input
              placeholder="Unique ID e.g. cold-coffee"
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              disabled={Boolean(editingId)}
              required
            />
            <input
              placeholder="Dish name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
            <input
              placeholder="Category"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              required
            />
            <input
              type="number"
              min="0"
              placeholder="Price ₹"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              required
            />
            <input
              className="wide-input"
              placeholder="Short description"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
            <button className="gold-btn" type="submit" disabled={menuSaving}>
              {menuSaving ? <><Spinner className="button-spinner" /> Saving…</> : <>{editingId ? "Update dish" : "Save dish"}{" "}<span>{editingId ? "✓" : "+"}</span></>}
            </button>
          </form>
          {message && <p className="form-success">{message}</p>}
          <div className="admin-menu-list">
            {menu.map((item) => (
              <div className="admin-menu-row" key={item.id}>
                <div>
                  <b>{item.name}</b>
                  <small>
                    {item.category} · {money(item.price)}
                    {!item.available ? " · SOLD OUT" : ""}
                  </small>
                </div>
                <div className="menu-actions">
                  <button
                    type="button"
                    className="edit-btn"
                    onClick={() => editDish(item)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="delete-btn"
                    onClick={() => deleteDish(item)}
                    disabled={menuDeleting === item.id}
                  >
                    {menuDeleting === item.id ? <><Spinner className="button-spinner" /> Deleting…</> : "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="menu-count">
            {menu.length} dishes currently live in the menu.
          </p>
        </section>
        )}
      </main>
    </div>
  );
}
export default App;
