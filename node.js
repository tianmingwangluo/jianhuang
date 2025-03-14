const express = require('express');
const app = express();
const http = require('http');
const httpServer = http.createServer(app);
const io = require('socket.io')(httpServer);
const { URL } = require('url');
const https = require('https');
const { Worker } = require('worker_threads');
const os = require('os');

app.use(express.json());
app.use(express.static('public'));

let downloadRunning = false;
let totalBytes = 0;
let currentController = null; // 当前请求的 AbortController
let currentTaskStartTime = null; // 当前任务启动时间（毫秒数）
let records = []; // 保存每次任务的数据记录
let activeWorkers = []; // 活跃的工作线程
let currentRemoteIP = '未知';

// 获取CPU核心数来决定线程数，但最多使用8个线程
const MAX_THREADS = Math.min(os.cpus().length, 8);

// 在主线程中创建一个子线程池管理函数
function createWorkerPool(url, controller) {
  const workerCount = MAX_THREADS;
  console.log(`启动 ${workerCount} 个下载线程`);
  
  for (let i = 0; i < workerCount; i++) {
    const worker = new Worker(`
      const { parentPort } = require('worker_threads');
      const http = require('http');
      const https = require('https');
      const { URL } = require('url');

      parentPort.on('message', ({ url, id }) => {
        const urlObj = new URL(url);
        const lib = urlObj.protocol === 'https:' ? https : http;
        let bytesDownloaded = 0;
        let running = true;

        function download() {
          if (!running) return;
          
          const req = lib.get(url, (res) => {
            let remoteIP = '';
            if (res.socket && res.socket.remoteAddress) {
              remoteIP = res.socket.remoteAddress;
              parentPort.postMessage({ type: 'ip', ip: remoteIP });
            }
            
            res.on('data', (chunk) => {
              bytesDownloaded += chunk.length;
              parentPort.postMessage({ type: 'progress', bytes: chunk.length });
            });
            
            res.on('end', () => {
              if (running) {
                setImmediate(() => download());
              }
            });
            
            res.on('error', (err) => {
              if (!running) return;
              console.error("Worker response error:", err);
              setTimeout(() => {
                if (running) {
                  download();
                }
              }, 1000);
            });
          });
          
          req.on('error', (err) => {
            if (!running) return;
            console.error("Worker request error:", err);
            setTimeout(() => {
              if (running) {
                download();
              }
            }, 1000);
          });
        }
        
        // 开始下载循环
        download();
        
        // 监听停止消息
        parentPort.on('message', (msg) => {
          if (msg.type === 'stop') {
            running = false;
          }
        });
      });
    `, { eval: true });
    
    // 记录每秒从工作线程接收的字节数
    worker.on('message', (message) => {
      if (message.type === 'progress') {
        totalBytes += message.bytes;
      } else if (message.type === 'ip') {
        currentRemoteIP = message.ip;
      }
    });
    
    // 启动工作线程的下载任务
    worker.postMessage({ url, id: i });
    activeWorkers.push(worker);
  }
}

/**
* downloadLoop(downloadUrl, controller)
* 循环下载目标 URL 内容，不保存数据，仅统计传输数据量和速率。
* 每秒使用 setInterval 推送一次由本次下载周期内获得的数据统计，
* 并将累计流量转换为 GB、当前周期速率转换为 Mb/s 后发送到前端。
*/
function downloadLoop(downloadUrl, controller) {
  if (!downloadRunning) return;

  // 创建多个工作线程进行下载
  createWorkerPool(downloadUrl, controller);
  
  const startTime = Date.now();
  let lastTotalBytes = 0;
  
  const statInterval = setInterval(() => {
    const currentTime = Date.now();
    const duration = (currentTime - startTime) / 1000;
    const intervalDuration = 1; // 1秒
    const bytesDuringInterval = totalBytes - lastTotalBytes;
    const speedMbps = ((bytesDuringInterval * 8 / intervalDuration) / 1e6);
    const totalGB = totalBytes / (1024 * 1024 * 1024);
    
    io.emit('stats', {
      totalGB: totalGB.toFixed(3),
      lastSpeedMbps: speedMbps.toFixed(3),
      ip: currentRemoteIP,
      threads: activeWorkers.length
    });
    
    lastTotalBytes = totalBytes;
  }, 1000);

  // 存储interval引用以便稍后清除
  controller.interval = statInterval;
}

app.post('/start', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: '缺少 URL 参数' });
  }
  
  // 如果有之前未结束的任务，先取消
  if (currentController) {
    currentController.abort();
    if (currentController.interval) {
      clearInterval(currentController.interval);
    }
    terminateWorkers();
    currentController = null;
  }
  
  totalBytes = 0;
  downloadRunning = true;
  currentTaskStartTime = Date.now();
  currentController = new AbortController();
  downloadLoop(url, currentController);
  
  return res.json({ 
    status: '开始下载', 
    url,
    threads: MAX_THREADS
  });
});

app.post('/stop', (req, res) => {
  downloadRunning = false;
  
  if (currentController) {
    if (currentController.interval) {
      clearInterval(currentController.interval);
    }
    currentController.abort();
    currentController = null;
  }
  
  const endTime = Date.now();
  const durationSec = (endTime - currentTaskStartTime) / 1000;
  
  // 停止所有工作线程
  terminateWorkers();
  
  const record = {
    startTime: new Date(currentTaskStartTime).toLocaleString(),
    endTime: new Date(endTime).toLocaleString(),
    durationSec: durationSec.toFixed(2),
    totalGB: (totalBytes / (1024 * 1024 * 1024)).toFixed(3),
    averageSpeedMbps: durationSec > 0 ? (((totalBytes * 8) / durationSec) / 1e6).toFixed(3) : "0.000",
    threads: MAX_THREADS
  };
  records.push(record);
  
  return res.json({ status: '停止下载', record });
});

// 终止所有工作线程的助手函数
function terminateWorkers() {
  for (const worker of activeWorkers) {
    worker.postMessage({ type: 'stop' });
    worker.terminate();
  }
  activeWorkers = [];
}

// 新增路由，返回所有任务的记录
app.get('/records', (req, res) => {
  res.json(records);
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

httpServer.listen(3000, () => {
  console.log('服务器启动，监听 3000 端口');
  console.log(`系统有 ${os.cpus().length} 个CPU核心，将使用 ${MAX_THREADS} 个下载线程`);
});