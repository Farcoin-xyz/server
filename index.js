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
const provider = new ethers.JsonRpcProvider('https://base.publicnode.com', undefined, {
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
    const toBlock = Math.min(fromBlock + 120, latestBlock - 5);

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
    const toBlock = Math.min(fromBlock + 120, latestBlock - 5);

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

const sendResponse = (res, error, results) => {
  if (error) {
    res.status(500);
    res.set('content-type', 'application/json');
    res.send({
      errors: [error.toString()]
    });
  } else {
    res.status(200);
    res.set('content-type', 'application/json');
    res.send(JSON.stringify({
      results: results
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

// client.fetchBulkUsers([2, 3], { viewerFid: 1 }).then(response => {
//   console.log('Bulk Users Information:', response.users.map(r => [r.fid, r.username]));
// });

const getReactionsToUser = async (likedFid, maxResults, result, nextCursor, depth) => {
  const { result: { notifications, next } } = await client.fetchUserLikesAndRecasts(likedFid, {
    limit: 150,
    cursor: nextCursor
  });

  let cutoff = false;
  for (let i = 0; i < notifications.length; i++) {
    const { reactors, reactionType } = notifications[i];
    if (reactionType === 'like') {
      for (let j = 0; j < reactors.length; j++) {
        const { fid, username, timestamp } = reactors[j];
        if (!result.fidLikes[fid]) {
          // First time seeing this fid
          result.count++;
          result.fidNames[fid] = username;
          result.fidLikes[fid] = 1;
        } else {
          result.fidLikes[fid]++;
        }
        result.fidLastLikeTime[fid] = Math.max(
          result.fidLastLikeTime[fid] || 0,
          Math.floor(new Date(timestamp).getTime() / 1000),
        );

        if (result.count >= maxResults) {
          cutoff = true;
          break;
        }
      }
    }
  };
  if (!next.cursor || cutoff || depth == 4) {
    return;
  }
  await getReactionsToUser(likedFid, maxResults, result, next.cursor, depth + 1);
};

app.post('/mint', async (req, res) => {
  try {
    const { likerFid } = req.body;
    const { address: likedAddress } = req.session.user;
    const { result: { user: liked } } = await client.lookupUserByVerification(likedAddress);
    const likedFid = liked.fid;
    const results = await Promise.all(signerURLs.map(async (url, i) => {
      const response = await axios.post(`${url}/mint`, {
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
    console.error(e)
    sendResponse(res, e);
  }
});

app.get('/scan', async (req, res) => {
  try {
    const { address } = req.query;
    const { result: { user } } = await client.lookupUserByVerification(address);
    if (!user) {
      throw new Error('Farcaster User Not Found: '+ address);
    }
    if (user.verifications.filter(v => v.toLowerCase() == (address || '').toLowerCase()).length === 0) {
      throw new Error('Farcaster Address Verification Not Found For: '+ address);
    }
    const result = {
      fidLastLikeTime: {},
      fidLastMintTime: {},
      fidLikes: {},
      fidNames: {},
      FIDs: [],
      count: 0,
    };

    const maxResults = 1000;
    await getReactionsToUser(user.fid, maxResults, result, null, 1);

    result.FIDs = Object.keys(result.fidLikes).sort((fidA, fidB) => {
      // Newest to oldest
      return result.fidLastLikeTime[fidA] > result.fidLastLikeTime[fidB] ? -1 : 1
    });
    const userFIDRepeated = Array.from({ length: result.count }, () => user.fid);
    const lastMintTimes = (
      await minter.getLastLikeTimes(userFIDRepeated, result.FIDs)
    ).map(n => Number(n));
    lastMintTimes.forEach((t, i) => {
      result.fidLastMintTime[result.FIDs[i]] = t;
    });

    sendResponse(res, null, result);
  } catch (e) {
    sendResponse(res, e);
  }
});

const port = 8000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
