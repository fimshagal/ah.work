import type { ReactNode } from "react";
import "../styles.css";

export type NavKey = "home" | "examples" | "demo" | "tutorial" | "docs";

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "home", href: "/index.html", label: "Home" },
  { key: "examples", href: "/examples.html", label: "Examples" },
  { key: "demo", href: "/demo.html", label: "Demo" },
  { key: "tutorial", href: "/tutorial.html", label: "Tutorial" },
  { key: "docs", href: "/docs.html", label: "API" },
];

/** Sticky top navigation with the active page highlighted. */
function Nav({ active }: { active: NavKey }) {
  return (
    <nav className="topnav">
      <span className="brand">AhWork</span>
      <div className="links">
        {NAV.map((item) => (
          <a
            key={item.key}
            href={item.href}
            className={item.key === active ? "active" : ""}
          >
            {item.label}
          </a>
        ))}
      </div>
    </nav>
  );
}

/** Page shell shared by every page: nav bar + centred <main>. */
export function Layout({
  active,
  children,
}: {
  active: NavKey;
  children: ReactNode;
}) {
  return (
    <>
      <Nav active={active} />
      <main>{children}</main>
    </>
  );
}
