const [major] = process.versions.node.split(".").map(Number);

if (!Number.isInteger(major) || major < 20) {
  console.error("");
  console.error(`[preflight] Node.js ${process.versions.node} detectado.`);
  console.error(
    "[preflight] Se requiere Node.js 20 LTS o superior (Next.js 15, Nest 11 y dependencias)."
  );
  console.error("[preflight] Instala desde: https://nodejs.org/");
  console.error("");
  process.exit(1);
}

console.log(`[preflight] Node.js ${process.versions.node} OK.`);
