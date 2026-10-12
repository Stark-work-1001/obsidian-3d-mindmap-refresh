# Third-party notices

- Rust physics derives from Obsidian 3D Graph 2.8.1, copyright 2025 Aryan Gupta, MIT. Full license: `licenses/obsidian_3d_graph_MIT.txt`. Modified for outline levels, fixed nodes, collision radii and coincident-position safety.
- The user-provided 1.15.0 distribution embeds Three.js r160, KaTeX 0.16.47 (versions read from the recovered source), and d3-force-3d (exact bundled version unavailable without the original lockfile). Existing code, license comments, CSS and fonts are retained. Full Three.js and KaTeX MIT licenses are in `licenses/`; the d3-force-3d MIT text, copyright 2017 Vasco Asturiano, was retrieved from the 3.0.6 package to retain its permission notice. d3's underlying components retain their upstream licenses; exact original dependency versions should be checked if the lost lockfile is recovered.
- Rust dependencies and exact versions are recorded in Cargo.lock. Build dependencies are recorded in package-lock.json. They are not installed into Obsidian at runtime.
- Backup configuration files, API credentials and private vault notes are excluded from both public source packaging and release packaging.
