const net = require("net");

const requiredPorts = [3000, 3001];

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function main() {
  const busy = [];
  for (const port of requiredPorts) {
    const free = await canListen(port);
    if (!free) busy.push(port);
  }

  if (busy.length > 0) {
    console.error(
      `[ports] Puertos ocupados: ${busy.join(
        ", "
      )}. Cierra procesos previos (node/npm) y reintenta.`
    );
    process.exit(1);
  }

  console.log("[ports] Puertos 3000/3001 disponibles.");
}

void main();
