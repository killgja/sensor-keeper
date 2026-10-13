# Sky Warden ⇄ Sensor Keeper remote protocol (v1, Hedera testnet)

Lets the Sky Warden iPhone app ask Sensor Keeper (running on a computer on the sensor's home
network) to run a small, fixed set of actions — from anywhere, with no server and no open ports.
Hedera Consensus Service (HCS) carries the messages. Testnet only for now (free test HBAR).

## Accounts and keys

| Thing | Owner | Created by | Key stored |
|---|---|---|---|
| **Control account** | the user | the user, free, at portal.hedera.com | on the computer only (Sensor Keeper config, file mode 600) |
| **Phone account** | Sky Warden | Sensor Keeper, funded with 50 test HBAR from the control account | iPhone Keychain only |
| **Command topic** | Sensor Keeper | Sensor Keeper | — |

- The sensor's own account and key are **never** used or touched.
- Topic **submit key** = 1-of-2 KeyList (control key, phone key): only the paired computer and phone can post.
- Topic **admin key** = control key (so the topic can be deleted/rotated); memo `skywarden-remote-v1`.
- A per-pairing 256-bit **shared secret** encrypts every message (AES-256-GCM).

## Pairing (one time, in person)

`keeper remote pair` creates the phone account + topic and shows a QR code **on the computer's screen**.
The QR holds JSON: `{"v":1,"net":"testnet","topic":"0.0.T","phoneAccount":"0.0.P","phoneKey":"<ed25519 private, DER hex>","secret":"<32 bytes base64>","computer":"<name>"}`.
The QR never leaves the room: nothing in it is sent over the network. Re-pairing creates a new
phone account/key/secret and the old phone key is removed from the topic submit key.

## Messages

Every HCS message body is `base64( nonce(12) || AES-256-GCM(ciphertext || tag) )` with
AAD = `skywarden-remote-v1|<topic id>`. Plaintext is JSON:

Request (phone → computer):
```json
{"t":"req","id":"<uuid>","ts":1791900000,"cmd":"check","sensor":"0.0.S","args":{}}
```
Reply (computer → phone):
```json
{"t":"rep","id":"<same uuid>","ts":1791900007,"ok":true,"summary":"Online, listed for buyers","detail":"…"}
```
Progress messages use `"t":"prog"` with the same id.

### Allowed commands (nothing else is ever executed)

| `cmd` | What Sensor Keeper does |
|---|---|
| `check` | Runs its normal diagnosis for that sensor and replies with the result. |
| `restart4dsky` | Uses its existing neuron-sdk-repair probe to restart the 4DSKY program on the sensor. |
| `applyFix` | Applies one community fix by name (`args.fix`), only if listed in its `COMMUNITY_FIXES` and only if the user has community fixes enabled. |

## Validation on the computer

A request is ignored (with a log line, no reply) unless **all** hold:
1. It decrypts and authenticates with the shared secret.
2. The HCS payer is the paired phone account.
3. `ts` is within ±5 minutes of the HCS consensus time, and `id` has not been seen before (replay protection).
4. `cmd` is in the allowed list and `sensor` is one of the sensors in Sensor Keeper's config.
5. Rate limit: at most 10 requests per hour.

## Transport details

- The computer reads the topic from the mirror node every 5 s (`/topics/{id}/messages?timestamp=gt:<last>`).
- The phone reads replies the same way while a request is pending (timeout 3 min).
- Cost: ~0.003 test HBAR per message. Testnet resets wipe accounts/topics; Sensor Keeper detects a
  missing topic and asks the user to pair again.
