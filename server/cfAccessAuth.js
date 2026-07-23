import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// Cloudflare Access is the entire auth boundary for this app. The plaintext
// Cf-Access-Authenticated-User-Email header it also sends is NOT trusted —
// a client that could reach the origin directly could set that header to
// anything. Identity comes only from the signed Cf-Access-Jwt-Assertion JWT,
// verified here against Cloudflare's own published keys.
let client;

function getJwksClient() {
  if (!client) {
    client = jwksClient({
      jwksUri: `https://${process.env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
      cache: true,
      cacheMaxAge: 12 * 60 * 60 * 1000
    });
  }
  return client;
}

function getSigningKey(kid) {
  return new Promise((resolve, reject) => {
    getJwksClient().getSigningKey(kid, (err, key) => {
      if (err) return reject(err);
      resolve(key.getPublicKey());
    });
  });
}

// Returns the verified token payload (including its `email` claim) or
// throws if the token is missing, expired, malformed, wrongly signed, or
// not issued for this specific Access application.
export async function verifyAccessJwt(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header?.kid) {
    throw new Error('Access token is missing a key id');
  }

  const publicKey = await getSigningKey(decoded.header.kid);

  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      publicKey,
      {
        algorithms: ['RS256'],
        audience: process.env.CF_ACCESS_AUD,
        issuer: `https://${process.env.CF_ACCESS_TEAM_DOMAIN}`
      },
      (err, payload) => {
        if (err) return reject(err);
        if (!payload?.email) return reject(new Error('Access token has no email claim'));
        resolve(payload);
      }
    );
  });
}
