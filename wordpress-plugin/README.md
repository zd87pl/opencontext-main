# OpenContext WordPress Plugin

A comprehensive WordPress plugin that integrates OpenContext Network's Web3 identity, context storage, and micropayment capabilities for content creators.

## Features

### 🔐 Web3 Authentication
- MetaMask wallet connection
- OpenContext Passport creation and management
- Cross-site identity persistence
- Secure authentication flow

### 💰 Content Monetization
- Streaming micropayments with Superfluid
- Sub-cent precision payments (USDC)
- Automatic paywall generation
- Creator revenue dashboard
- Real-time payment tracking

### 🧠 Context & Personalization
- Encrypted user preference storage
- Reading history tracking
- Personalized content recommendations
- Cross-site context sharing
- Advanced engagement analytics

### ⚙️ Easy Setup
- Simple admin configuration
- Contract address management
- Shortcode support
- Post editor integration
- Creator dashboard

## Installation

1. Download the plugin files
2. Upload to `/wp-content/plugins/opencontext-wp/`
3. Activate the plugin through WordPress admin
4. Configure settings in **OpenContext > Settings**

## Configuration

### 1. Smart Contract Setup

Navigate to **OpenContext > Settings** and configure:

- **RPC URL**: Your zkSync Era endpoint
- **Contract Addresses**: 
  - PassportRegistry: `0x1234...` (replace with actual)
  - ContextVault: `0x2345...` (replace with actual)  
  - PaymentStream: `0x3456...` (replace with actual)
- **Gateway URL**: OpenContext gateway proxy

### 2. Creator Setup

Go to **OpenContext > Creator Dashboard**:

1. Connect your wallet
2. Set your payment wallet address
3. Configure default payment rates
4. Add creator bio

## Usage

### For Content Creators

#### 1. Creating Premium Content

**Option A: Post Editor**
- Edit any post
- Check "Enable Premium Content" in the OpenContext meta box
- Set payment rate (USDC per minute)
- Add optional preview text
- Publish post

**Option B: Shortcodes**
```
[opencontext_premium rate="0.01" preview="This is a preview..."]
Premium content goes here
[/opencontext_premium]
```

#### 2. Revenue Tracking
- View earnings in Creator Dashboard
- Monitor active payment streams
- Export analytics data
- Withdraw earnings

### For Readers

#### 1. Wallet Connection
Add wallet widget anywhere:
```
[opencontext_wallet button_text="Connect Wallet"]
```

#### 2. Premium Content Access
- Readers connect wallet
- Create OpenContext Passport
- Start streaming payments for premium content
- Automatic content unlock

### Admin Features

#### Dashboard Analytics
- Total users and connected wallets
- Premium post metrics
- Revenue overview
- Recent activity feed

#### Quick Actions
- Test connection to contracts
- Sync contract data
- Export user data
- System health checks

## Shortcodes

### `[opencontext_wallet]`
Display wallet connection widget

**Parameters:**
- `button_text`: Custom button text (default: "Connect Wallet")
- `style`: CSS class for styling (default: "default")

**Example:**
```
[opencontext_wallet button_text="Link Your Wallet" style="custom"]
```

### `[opencontext_premium]`
Wrap premium content with paywall

**Parameters:**
- `rate`: Payment rate in USDC per minute (required)
- `preview`: Preview text shown before paywall (optional)

**Example:**
```
[opencontext_premium rate="0.02" preview="Get insights into..."]
This content requires payment to view.
[/opencontext_premium]
```

### `[opencontext_dashboard]`
Display creator earnings dashboard

**Example:**
```
[opencontext_dashboard]
```

## Technical Details

### Architecture
- **Frontend**: JavaScript with Web3 integration
- **Backend**: PHP with WordPress hooks
- **Smart Contracts**: Solidity on zkSync Era
- **Payments**: Superfluid streaming
- **Storage**: Encrypted context vault

### File Structure
```
opencontext-wp/
├── opencontext-wp.php          # Main plugin file
├── includes/
│   ├── admin-page.php          # Admin dashboard
│   ├── settings-page.php       # Settings configuration
│   ├── dashboard-page.php      # Creator dashboard
│   ├── post-meta-box.php       # Post editor integration
│   └── context-tracker.php     # User tracking & analytics
├── assets/
│   ├── js/
│   │   ├── frontend.js         # Frontend functionality
│   │   ├── admin.js            # Admin interface
│   │   ├── post-meta.js        # Post editor scripts
│   │   └── opencontext-sdk.min.js  # OpenContext SDK
│   └── css/
│       ├── frontend.css        # Frontend styles
│       └── admin.css           # Admin styles
└── README.md                   # This file
```

### Security Features
- Nonce verification for all AJAX calls
- Input sanitization and validation
- Encrypted context storage
- Secure payment flows
- Access control checks

## Development

### Prerequisites
- WordPress 5.0+
- PHP 7.4+
- MetaMask or Web3 wallet
- zkSync Era testnet/mainnet access

### Local Development
1. Clone to WordPress plugins directory
2. Configure test environment with:
   - zkSync Era Sepolia testnet
   - Test contracts deployed
   - Test USDC tokens

### Integration with OpenContext SDK

The plugin uses the OpenContext TypeScript SDK for blockchain interactions:

```javascript
// Initialize client
const client = new OpenContextClient({
    rpcUrl: config.rpc_url,
    contracts: {
        passport: config.passport_contract,
        vault: config.vault_contract,
        payment: config.payment_contract
    }
});

// Authenticate user
const passport = await client.authenticate();

// Store user context
await client.storeContext(JSON.stringify(contextData));

// Start payment stream
await client.streamPay(authorWallet, ratePerMinute);
```

## Roadmap

### Phase 1 ✅
- [x] Basic wallet connection
- [x] Premium content paywalls
- [x] Creator dashboard
- [x] Context tracking

### Phase 2 (In Progress)
- [ ] Enhanced analytics
- [ ] Multi-token support
- [ ] Batch payments
- [ ] Advanced permissions

### Phase 3 (Planned)
- [ ] Governance integration
- [ ] Cross-platform sync
- [ ] Enterprise features
- [ ] Plugin marketplace

## Support

### Documentation
- [OpenContext Docs](https://docs.opencontext.network)
- [WordPress Plugin Guide](https://docs.opencontext.network/wordpress)
- [Smart Contract Reference](https://docs.opencontext.network/contracts)

### Community
- [GitHub Issues](https://github.com/opencontext/opencontext-main/issues)
- [Discord Community](https://discord.gg/opencontext)
- [Developer Forum](https://forum.opencontext.network)

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create feature branch
3. Make changes
4. Add tests
5. Submit pull request

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.