const path = require('path');

const dotenv = require('dotenv');
const crypto = require('crypto');
const ethers = require('ethers');

const express = require('express');
const expressSession = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const bodyParser = require('body-parser');

const createClient = require('redis').createClient;
const RedisStore = require('connect-redis').default;
const mysql = require('mysql2/promise');

const { NeynarAPIClient } = require('@neynar/nodejs-sdk');
const { getSSLHubRpcClient, ReactionType } = require('@farcaster/hub-nodejs');

const axios = require('axios');
const cron = require('node-schedule');

const minterAbi = require('./minter-abi.json');

dotenv.config({ path: path.join(__dirname, '.env') });

const client = new NeynarAPIClient(process.env.NEYNAR_KEY);
const signerURLs = (process.env.SIGNER_URLS || '').split(' ');
const signerTokens = (process.env.SIGNER_TOKENS || '').split(' ');
const provider = new ethers.JsonRpcProvider('https://base-rpc.publicnode.com', undefined, {
  staticNetwork: true,
});
const minter = new ethers.Contract('0x9d5CE03b73a2291f5E62597E6f27A91CA9129d97', minterAbi, provider);

const redisClient = createClient({
  socket: {
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
  },
  password: process.env.REDIS_PASSWORD,
});
redisClient.connect();

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

cron.scheduleJob('*/30 * * * * *', async () => {
  try {
    const [row] = await db.query('SELECT last_block_number FROM log_scan WHERE log_type = ?', ['mint']);

    const latestBlock = await provider.getBlockNumber();
    const fromBlock = row.length > 0 ? row[0].last_block_number : 12919419;
    const toBlock = Math.min(fromBlock + 1000, latestBlock - 2);

    const mintLogs = await minter.queryFilter('Mint', fromBlock, toBlock);
    const mintData = [];
    let mintQuery = '';
    mintLogs.forEach(l => {
      mintQuery += ',(?,?,?,?,?,?,?,?,?,?)';
      mintData.push(
        Number(l.args.likerFID),
        Number(l.args.likedFID),
        l.args.liker,
        l.args.liked,
        Number(l.args.quantity),
        Number(l.args.firstLikeTime),
        Number(l.args.lastLikeTime),
        Number(l.args.timestamp),
        l.blockNumber,
        l.transactionHash,
      );
    });
    if (mintData.length > 0) {
      await db.query(`INSERT INTO mint (
        liker_fid,
        liked_fid,
        liker_address,
        liked_address,
        quantity_likes,
        first_like_time,
        last_like_time,
        block_timestamp,
        block_number,
        transaction_hash
      ) VALUES ${mintQuery.slice(1)} ON DUPLICATE KEY UPDATE id=id`, mintData);
    }
    await db.query('INSERT INTO log_scan (log_type, last_block_number) VALUES (?,?) ON DUPLICATE KEY UPDATE last_block_number=VALUES(last_block_number)', ['mint', toBlock]);
  } catch (e) {
    console.error(e);
  }
});

cron.scheduleJob('*/30 * * * * *', async () => {
  try {
    const [row] = await db.query('SELECT last_block_number FROM log_scan WHERE log_type = ?', ['claim']);

    const latestBlock = await provider.getBlockNumber();
    const fromBlock = row.length > 0 ? row[0].last_block_number : 12919419;
    const toBlock = Math.min(fromBlock + 1000, latestBlock - 2);

    const claimLogs = await minter.queryFilter('Claim', fromBlock, toBlock);
    const claimData = [];
    let claimQuery = '';
    claimLogs.forEach(l => {
      claimQuery += ',(?,?,?,?,?,?,?)';
      claimData.push(
        Number(l.args.likerFID),
        l.args.liker,
        Number(l.args.nonce),
        ethers.formatEther(l.args.tokens),
        Number(l.args.timestamp),
        l.blockNumber,
        l.transactionHash,
      );
    });
    if (claimData.length > 0) {
      await db.query(`INSERT INTO claim (
        liker_fid,
        liker_address,
        nonce,
        quantity_tokens,
        block_timestamp,
        block_number,
        transaction_hash
      ) VALUES ${claimQuery.slice(1)} ON DUPLICATE KEY UPDATE id=id`, claimData);
    }
    await db.query('INSERT INTO log_scan (log_type, last_block_number) VALUES (?,?) ON DUPLICATE KEY UPDATE last_block_number=VALUES(last_block_number)', ['claim', toBlock]);
  } catch (e) {
    console.error(e);
  }
});

const app = express();

const directives = helmet.contentSecurityPolicy.getDefaultDirectives();
directives['default-src'] = ["*"];
directives['script-src'] = ["*", "'unsafe-inline'"]; // Unsafe-inline is for MetaMask
directives['img-src'] = ["*"];

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives,
  },
}));

app.use(cors({
  credentials: true,
  origin: [
    'http://localhost:3030',
    'https://farcoin.xyz',
  ],
  optionsSuccessStatus: 200,
}));

app.use(cookieParser());
app.use(expressSession({
  secret: process.env.REDIS_SECRET,
  store: new RedisStore({
    client: redisClient,
  }),
  cookie: {
    maxAge: 2147483647
  },
  saveUninitialized: false,
  resave: false,
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('build'));

const sendResponse = (res, error, result) => {
  if (error) {
    res.status(500);
    res.set('content-type', 'application/json');
    res.send({
      error: error.message
    });
  } else {
    res.status(200);
    res.set('content-type', 'application/json');
    res.send(JSON.stringify({
      result
    }));
  }
};

app.get('/status', async (req, res) => {
  sendResponse(res, null, { status: 'Running' });
});

app.post('/session/start', async (req, res) => {
  const { address, signature } = req.body;
  const { code } = req.session;
  try {
    if (!code) {
      throw new Error('Invalid code');
    }
    const signer = ethers.verifyMessage(`Authenticating on Farcoin.xyz\n\nCode: ${code}`, signature);
    if (address !== signer) {
      throw new Error('Invalid signature');
    }
    req.session.user = {
      address,
    };
    delete req.session.code;
    sendResponse(res, null, {
      user: req.session.user,
    });
  } catch (e) {
    sendResponse(res, e);
  }
});

app.post('/session/end', async (req, res) => {
  delete req.session.code;
  delete req.session.user;
  sendResponse(res, null, null);
});

app.post('/session/code', async (req, res) => {
  const code = crypto.randomInt(1_000_000_000, 1_000_000_000_000).toString();
  req.session.code = code;
  sendResponse(res, null, { code });
});

app.get('/session', async (req, res) => {
  const user = req.session.user || {};
  sendResponse(res, null, { user });
});

const getFIDNames = async (FIDs) => {
  const fidNames = {};
  const r = await client.fetchBulkUsers(FIDs, { viewerFid: 1 });
  r.users.forEach(user => {
    fidNames[user.fid] = user.username;
  });
  return fidNames;
}

app.get('/recent-mints', async (req, res) => {
  try {
    const [recentMints] = await db.query('SELECT * FROM mint ORDER BY id DESC LIMIT 20');
    const fids = {};
    recentMints.forEach(m => {
      fids[m.liker_fid] = true;
      fids[m.liked_fid] = true;
    });
    const fidNames = await getFIDNames(Object.keys(fids));
    sendResponse(res, null, {
      recentMints,
      fidNames,
    });
  } catch (e) {
    sendResponse(res, e);
  }
});

app.get('/search-users', async (req, res) => {
  try {
    const { result: { users }} = await client.searchUser(req.query.username);
    sendResponse(res, null, users);
  } catch (e) {
    console.error(e)
    sendResponse(res, e);
  }
});

app.get('/user-by-fid', async (req, res) => {
  try {
    const { result: { user }} = await client.lookupUserByFid(req.query.fid);
    sendResponse(res, null, user);
  } catch (e) {
    console.error(e)
    sendResponse(res, e);
  }
});

app.get('/user-by-username', async (req, res) => {
  try {
    const { result: { user }} = await client.lookupUserByUsername(req.query.username);
    sendResponse(res, null, user);
  } catch (e) {
    console.error(e)
    sendResponse(res, e);
  }
});

app.get('/user-by-address', async (req, res) => {
  try {
    const { result: { user }} = await client.lookupUserByVerification(req.query.address);
    sendResponse(res, null, user);
  } catch (e) {
    console.error(e)
    sendResponse(res, e);
  }
});

app.get('/owned-by-fid', async (req, res) => {
  try {
    const [fidesOwned] = await db.query(
      'SELECT liker_fid, SUM(quantity_likes) AS likes, MAX(block_timestamp) AS last_mint_time FROM mint WHERE liked_fid = ? GROUP BY liker_fid ORDER BY last_mint_time DESC',
      [
        req.query.fid
      ]
    );
    if (fidesOwned.length > 0) {
      const fids = {};
      fidesOwned.forEach(m => {
        fids[m.liker_fid] = true;
      });
      const fidNames = await getFIDNames(Object.keys(fids));
      fidesOwned.forEach(m => {
        m.name = fidNames[m.liker_fid];
      });
    }
    sendResponse(res, null, fidesOwned);
  } catch (e) {
    console.error(e)
    sendResponse(res, e);
  }
});

app.get('/owners-by-fid', async (req, res) => {
  try {
    const [fideOwners] = await db.query(
      'SELECT liked_fid, SUM(quantity_likes) AS likes, MAX(block_timestamp) AS last_mint_time FROM mint WHERE liker_fid = ? GROUP BY liked_fid ORDER BY likes DESC',
      [
        req.query.fid
      ]
    );
    if (fideOwners.length > 0) {
      const fids = {};
      fideOwners.forEach(m => {
        fids[m.liked_fid] = true;
      });
      const fidNames = await getFIDNames(Object.keys(fids));
      fideOwners.forEach(m => {
        m.name = fidNames[m.liked_fid];
      });
    }
    sendResponse(res, null, fideOwners);
  } catch (e) {
    console.error(e)
    sendResponse(res, e);
  }
});

app.post('/mint', async (req, res) => {
  const { likerFid, likedAddress } = req.body;
  let likedFid = null;
  try {
    const { result: { user: liked } } = await client.lookupUserByVerification(likedAddress);
    likedFid = liked.fid;
  } catch (e) {
    console.error(likedAddress, e.response && e.response.data || e.message);
    sendResponse(res, new Error('Connected wallet not linked to a Farcaster account'));
    return;
  }
  try {
    const results = await Promise.all(signerURLs.map(async (url, i) => {
      const response = await axios.post(`${url}/api/mint`, {
        likerFid,
        likedFid,
        likedAddress,
      }, {
        headers: { Authorization: `Bearer ${signerTokens[i]}` }
      });
      return response.data.result;
    }));
    const signatures = results.map(r => r.signature);
    sendResponse(res, null, {
      mintArguments: results[0].arguments.concat([signatures]),
    });
  } catch (e) {
    if (e.response && e.response.data && e.response.data.error) {
      sendResponse(res, new Error(e.response.data.error));
    } else {
      sendResponse(res, e);
    }
  }
});

app.get('/*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'build/index.html'));
});

const port = 8000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
