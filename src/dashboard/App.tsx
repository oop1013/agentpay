import React from "react";
import { Routes, Route, NavLink } from "react-router-dom";
import Home from "./pages/Home";
import Browse from "./pages/Browse";
import Services from "./pages/Services";
import Provider from "./pages/Provider";
import History from "./pages/History";
import Authorizations from "./pages/Authorizations";
import Marketplace from "./pages/Marketplace";
import Quickstart from "./pages/Quickstart";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unhandled error:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen bg-gray-50">
          <div className="text-center">
            <p className="text-gray-700 font-medium mb-2">Something went wrong.</p>
            <p className="text-gray-500 text-sm">Please refresh the page.</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const navItems = [
  { to: "/", label: "Home" },
  { to: "/quickstart", label: "Quickstart" },
  { to: "/marketplace", label: "Marketplace" },
  { to: "/browse", label: "Browse" },
  { to: "/services", label: "Services" },
  { to: "/provider", label: "Provider" },
  { to: "/history", label: "History" },
  { to: "/authorizations", label: "Authorizations" },
];

export default function App() {
  return (
    <ErrorBoundary>
      <div className="flex min-h-screen">
        <nav className="w-56 bg-gray-900 text-gray-100 p-4 flex-shrink-0">
          <h1 className="text-lg font-bold mb-6">AgentPay</h1>
          <ul className="space-y-1">
            {navItems.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    `block px-3 py-2 rounded text-sm ${
                      isActive
                        ? "bg-gray-700 text-white font-medium"
                        : "text-gray-300 hover:bg-gray-800"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="flex-1 p-6">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/marketplace" element={<Marketplace />} />
            <Route path="/browse" element={<Browse />} />
            <Route path="/services" element={<Services />} />
            <Route path="/provider" element={<Provider />} />
            <Route path="/history" element={<History />} />
            <Route path="/authorizations" element={<Authorizations />} />
            <Route path="/quickstart" element={<Quickstart />} />
          </Routes>
        </main>
      </div>
    </ErrorBoundary>
  );
}
