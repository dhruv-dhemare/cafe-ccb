import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import "./App.css";

const API = import.meta.env.VITE_API_URL || "/api";
const ADMIN_PATH =
  import.meta.env.VITE_ADMIN_BASE_PATH || "/private-cafe-console";
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
    [notice, setNotice] = useState(""),
    [receipt, setReceipt] = useState(readStoredReceipt),
    [paying, setPaying] = useState(false);
  const [showIntro, setShowIntro] = useState(
    !window.location.pathname.startsWith(ADMIN_PATH),
  );
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, []);
  const navigate = (path) => {
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
    fetch(`${API}/menu`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setMenu)
      .catch(() => {});
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
  const placeOrder = async (e) => {
    e.preventDefault();
    if (!/^\d{10}$/.test(phone.replace(/\D/g, "")))
      return setNotice("Please enter a valid 10-digit mobile number.");
    setNotice("");
    setPaying(true);
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
          items: cart.map(({ id, quantity }) => ({ id, quantity })),
        }),
      });
      const paymentOrder = await create.json();
      if (!create.ok)
        throw Error(paymentOrder.error || "Unable to start payment");
      if (paymentOrder.paymentMethod === "KHATTA") {
        sessionStorage.setItem("ccb-receipt", JSON.stringify(paymentOrder));
        setReceipt(paymentOrder);
        setCart([]);
        setPaying(false);
        navigate(`/success?source=${orderSource}`);
        return;
      }
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
            navigate(`/success?source=${orderSource}`);
          } catch (error) {
            setNotice(error.message);
          } finally {
            setPaying(false);
          }
        },
        modal: {
          ondismiss: () => {
            setNotice("Payment cancelled. Your cart is still saved.");
            setPaying(false);
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
      });
      razorpay.open();
    } catch (error) {
      setNotice(error.message);
      setPaying(false);
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
        setPhone={setPhone}
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
          updateCart={updateCart}
          cart={cart}
        />
      ) : (
        <Menu
          menu={mainMenu}
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
function Menu({ menu, category, categories, setCategory, updateCart, cart }) {
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [category]);
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
function CigarettesMenu({ menu, updateCart, cart }) {
  const [search, setSearch] = useState("");
  const cigaretteMenu = menu.filter((item) => item.category === "Cigarettes");
  const visibleMenu = cigaretteMenu.filter((item) =>
    item.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
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
  onSubmit,
  onBack,
  notice,
  paying,
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
          {notice && <p className="form-error">{notice}</p>}
          <button className="gold-btn full" type="submit" disabled={paying}>
            {paying ? (
              "Opening secure checkout…"
            ) : (
              <>
                Pay {money(total)} <span>→</span>
              </>
            )}
          </button>
          <p className="secure-note">
            Razorpay secure checkout · Payment confirmed by server
          </p>
        </form>
      </div>
    </div>
  );
}
function Success({ receipt, onMenu }) {
  const khattaOrder = receipt.paymentStatus === "KHATTA";
  return (
    <div className="success-page">
      <div className="success-card">
        <div className="success-icon">✓</div>
        <p className="eyebrow">{khattaOrder ? "ORDER CONFIRMED" : "PAYMENT SUCCESSFUL"}</p>
        <h1>
          Thank you for
          <br />
          <em>ordering in.</em>
        </h1>
        <p className="success-message">
          Your order is confirmed and your digital receipt is ready.
        </p>
        <div className="receipt-preview">
          <span>
            ORDER <b>{receipt.orderNumber}</b>
          </span>
          <span>
            {khattaOrder ? "ORDER TOTAL" : "AMOUNT PAID"} <b>{money(receipt.total)}</b>
          </span>
          <span>
            MOBILE <b>+91 {receipt.phone}</b>
          </span>
        </div>
        <button
          className="gold-btn full"
          onClick={() =>
            window.open(`${API}/receipts/${receipt.reference}`, "_blank")
          }
        >
          View digital bill <span>↗</span>
        </button>
        <button className="text-btn" onClick={onMenu}>
          Back to menu
        </button>
      </div>
    </div>
  );
}
const ADMIN_ROUTES = ["order", "menu", "khatta"];
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
    [error, setError] = useState("");
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
    [statusSaving, setStatusSaving] = useState(null),
    [khattaUsers, setKhattaUsers] = useState([]),
    [khattaForm, setKhattaForm] = useState({ name: "", phone: "" }),
    [khattaSearch, setKhattaSearch] = useState(""),
    [khattaMessage, setKhattaMessage] = useState(""),
    [khattaBusy, setKhattaBusy] = useState(null);
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
  };
  const saveDish = async (e) => {
    e.preventDefault();
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
      load();
    } else setMessage("Could not save dish");
  };
  const editDish = (item) => {
    setForm({ ...item, price: String(item.price) });
    setEditingId(item.id);
    setMessage("Editing dish — save when ready");
  };
  const deleteDish = async (item) => {
    if (!window.confirm(`Remove ${item.name} from the menu?`)) return;
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
      load();
    } else setMessage("Could not remove dish");
  };
  const markServed = async (order) => {
    setStatusSaving(order.id);
    const r = await fetch(`${adminApi}/orders/${order.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    if (r.ok) {
      setOrders((current) =>
        current.map((item) =>
          item.id === order.id ? { ...item, order_status: "COMPLETED" } : item,
        ),
      );
    }
    setStatusSaving(null);
  };
  const saveKhattaUser = async (e) => {
    e.preventDefault();
    setKhattaMessage("");
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
            <button className="gold-btn full">
              Enter dashboard <span>→</span>
            </button>
          </form>
          <p className="secure-note">Cafe Coffee Bar 3.0 · staff only</p>
        </div>
      </div>
    );
  const activeOrders = orders.filter(
      (o) => o.order_status !== "COMPLETED" && o.order_status !== "CANCELLED",
    ),
    today = orders.filter(
      (o) => new Date(o.createdAt).toDateString() === new Date().toDateString(),
    ),
    sales = today.reduce((s, o) => s + o.total, 0);
  const visibleKhattaUsers = khattaUsers.filter((user) => {
    const query = khattaSearch.trim().toLowerCase();
    return !query || user.name.toLowerCase().includes(query) || user.phone.includes(query);
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
          <>
        <section className="admin-section recent-section">
          <div className="admin-section-head">
            <div>
              <p className="eyebrow">ACTION REQUIRED</p>
              <h2>Recent orders</h2>
            </div>
            <span className="active-count">{activeOrders.length} to serve</span>
          </div>
          <div className="orders-table">
            <div className="order-row order-head">
              <span>Order</span>
              <span>Items</span>
              <span>Mobile</span>
              <span>Total</span>
              <span>Payment</span>
            </div>
            {activeOrders.length ? (
              activeOrders.map((o) => (
                <div className="order-row recent-order-row" key={o.id}>
                  <span>
                    <b>{o.order_number}</b>
                    <small>
                      {new Date(o.createdAt).toLocaleTimeString("en-IN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </small>
                    <button
                      className="served-btn"
                      type="button"
                      onClick={() => markServed(o)}
                      disabled={statusSaving === o.id}
                    >
                      {statusSaving === o.id ? "Saving…" : "✓ Served"}
                    </button>
                  </span>
                  <span className="order-items">
                    {o.items.map((i) => (
                      <span key={i.menuItemId}>
                        {i.quantity} × {i.itemName}
                      </span>
                    ))}
                  </span>
                  <span>+91 {o.phone}</span>
                  <span>{money(o.total)}</span>
                  <span>
                    <b className="paid">{o.payment_status}</b>
                  </span>
                </div>
              ))
            ) : (
              <p className="empty-state">
                All caught up. Served orders will move to order history.
              </p>
            )}
          </div>
        </section>
        <div className="stats">
          <div>
            <span>Today's orders</span>
            <b>{today.length}</b>
          </div>
          <div>
            <span>Today's sales</span>
            <b>{money(sales)}</b>
          </div>
          <div>
            <span>All paid orders</span>
            <b>{orders.length}</b>
          </div>
        </div>
        <section className="admin-section">
          <div className="admin-section-head">
            <div>
              <p className="eyebrow">ORDER HISTORY</p>
              <h2>All orders</h2>
            </div>
          </div>
          <div className="orders-table">
            <div className="order-row order-head">
              <span>Order</span>
              <span>Items</span>
              <span>Mobile</span>
              <span>Total</span>
              <span>Status</span>
            </div>
            {orders.length ? (
              orders.map((o) => (
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
                  <span>{money(o.total)}</span>
                  <span>
                    <b className="paid">{o.payment_status}</b>
                    <small className="service-status">
                      {o.order_status === "COMPLETED" ? "✓ SERVED" : "WAITING"}
                    </small>
                  </span>
                </div>
              ))
            ) : (
              <p className="empty-state">No orders yet.</p>
            )}
          </div>
        </section>
          </>
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
            <button className="gold-btn" type="submit">Add customer <span>+</span></button>
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
                  {khattaBusy === user.id ? "Preparing…" : "Download & settle"}
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
            <button className="gold-btn">
              {editingId ? "Update dish" : "Save dish"}{" "}
              <span>{editingId ? "✓" : "+"}</span>
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
                  >
                    Delete
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
