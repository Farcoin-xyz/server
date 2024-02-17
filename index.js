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

const { NeynarAPIClient } = require('@neynar/nodejs-sdk');
const { getSSLHubRpcClient, ReactionType } = require('@farcaster/hub-nodejs');
const frcAbi = require('./frc-abi.json');

dotenv.config({ path: path.join(__dirname, '.env') });

const client = new NeynarAPIClient(process.env.NEYNAR_KEY);
const frcSigner = ethers.Wallet.fromPhrase(process.env.FARCOIN_SIGNER);
const provider = new ethers.JsonRpcProvider('https://base.publicnode.com', undefined, {
  staticNetwork: true,
});
const contract = new ethers.Contract('0xEcB5DF8f302706bC0a8F383904b67663b886a9e1', frcAbi, provider);

const redisClient = createClient({
  socket: {
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
  },
  password: process.env.REDIS_PASSWORD,
});
redisClient.connect();

const app = express();

const directives = helmet.contentSecurityPolicy.getDefaultDirectives();
directives['default-src'] = ["*"];
directives['script-src'] = ["*", "'unsafe-inline'"]; // Unsafe-inline is for MetaMask
directives['img-src'] = ["*"]; // For NFT Metadata

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

app.get('/sign', async (req, res) => {
  const frcEpoch = 1609459200;
  try {
    const { likerFid } = req.query;
    const { address: likedAddress } = req.session.user;
    const { result: { user: liked } } = await client.lookupUserByVerification(likedAddress);
    const rangeClose = parseInt((await contract.getLikerLikedRangeClose(liked.fid, likerFid)).toString());
    const result = {
      mintArguments: [],
    };
    const hubClient = getSSLHubRpcClient(process.env.HUB_GRPC_URL);
    hubClient.$.waitForReady(Date.now() + 5000, async (e) => {
      if (e) {
        console.error(`Failed to connect to the gRPC server:`, e);
        sendResponse(res, new Error('Failed to connect to the gRPC server'));
        return;
      }
      try {
        let startTime = null;
        let endTime = null;
        let numTokens = 0;

        let isNextPage = true;
        let nextPageToken = undefined;
        while (isNextPage) {
          const reactions = await hubClient.getReactionsByFid({
            fid: likerFid,
            reactionType: ReactionType.LIKE,
            pageToken: nextPageToken,
          });
          if (reactions.error) {
            console.error(reactions.error);
            sendResponse(res, new Error('Unable to fetch reactions'));
            hubClient.close();
            return;
          }
          const { messages } = reactions.value;
          for (let i = 0; i < messages.length; i++) {
            const {
              type,
              timestamp,
              reactionBody: {
                targetCastId: {
                  fid,
                },
              },
            } = messages[i].data;
            const t = timestamp + frcEpoch;
            if (fid === liked.fid && t > rangeClose) {
              endTime = Math.max(endTime || 0, t);
              startTime = Math.min(startTime || Infinity, t);
              numTokens++;
            }
          };
          nextPageToken = reactions.value.nextPageToken;
          isNextPage = !!nextPageToken && nextPageToken.length > 0;
        }
        hubClient.close();
        if (numTokens === 0) {
          throw new Error("No tokens to mint");
        }
        result.mintArguments = [
          likedAddress,
          liked.fid,
          [likerFid],
          [numTokens],
          [startTime],
          [endTime],
        ];
        const contractMessage = ethers.AbiCoder.defaultAbiCoder().encode(
          [ "address", "uint256", "uint256[]", "uint256[]", "uint256[]", "uint256[]" ],
          result.mintArguments
        );
        const contractMsgHash = ethers.keccak256(contractMessage);
        const contractSignature = await frcSigner.signMessage(ethers.getBytes(contractMsgHash));
        result.mintArguments.push([contractSignature]);
        sendResponse(res, null, result);
      } catch (e) {
        console.error(e)
        sendResponse(res, e);
      }
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

    const lastMintTimes = (await contract.getLikersLikedRangeClose(user.fid, result.FIDs)).map(n => parseInt(n.toString()));
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
