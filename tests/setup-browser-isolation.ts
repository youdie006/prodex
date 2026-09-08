// Keep the suite off the real browser.
//
// prodex reaches ChatGPT through a Chrome DevTools port, and 9333 is where a
// developer's own logged-in window listens. Any test that walked into that code
// path therefore drove a real session: `prodex setup` verifies a pinned default
// by opening the composer picker, so the setup tests connected to the live
// browser, opened its menu and - once the listing learned to walk the power
// slider - stepped that slider from end to end. It surfaced as a 30s test
// timeout, not as anything that named the cause.
//
// Pointing the default at a port nothing listens on keeps every such probe
// away from a browser: a connect there is refused, or on hosts that black-hole
// closed loopback ports (measured on WSL2) it times out - either way nothing
// answers. Set unconditionally, so a port exported in the developer's shell
// cannot route the suite at a real window. Tests that are ABOUT the variable
// take it over for their own duration and put this value back.
process.env.PRODEX_CDP_PORT = "59333";
