# Development licence key

`dev-licence-private.pem` is an Ed25519 private key **committed on purpose**. It signs licences on
a laptop and nowhere else: `loadPlatformConfig` refuses it under `NODE_ENV=production`, where
`LICENCE_SIGNING_KEY` must be supplied.

There is no public PEM to keep in step -- the public half is derived from this one at boot and
published at `GET /licence/jwks`, which is how a data plane verifies a licence **offline** (CG1)
while holding no key that could mint one (CE1).
