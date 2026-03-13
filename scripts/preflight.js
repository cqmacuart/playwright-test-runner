const [major] = process.versions.node.split('.').map(Number);

if (!Number.isInteger(major) || major < 20) {
  console.error(
    `[preflight] Node.js ${process.versions.node} detectado. Este proyecto requiere Node.js >= 20.`
  );
  process.exit(1);
}

console.log(`[preflight] Node.js ${process.versions.node} OK.`);
