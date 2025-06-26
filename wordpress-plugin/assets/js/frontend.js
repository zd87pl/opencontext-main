class OpenContextWP {
    constructor() {
        this.client = null;
        this.wallet = null;
        this.passport = null;
        this.config = opencontext_ajax.config;
        
        this.init();
    }
    
    async init() {
        await this.loadSDK();
        this.initEventListeners();
        this.checkExistingConnection();
    }
    
    async loadSDK() {
        if (typeof window.OpenContextClient === 'undefined') {
            console.error('OpenContext SDK not loaded');
            return;
        }
        
        this.client = new window.OpenContextClient({
            rpcUrl: this.config.rpc_url,
            contracts: {
                passport: this.config.passport_contract,
                vault: this.config.vault_contract,
                payment: this.config.payment_contract
            },
            gatewayUrl: this.config.gateway_url
        });
    }
    
    initEventListeners() {
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('opencontext-connect-btn')) {
                e.preventDefault();
                this.connectWallet();
            }
            
            if (e.target.classList.contains('opencontext-pay-btn')) {
                e.preventDefault();
                this.handlePayment(e.target);
            }
        });
        
        window.addEventListener('load', () => {
            this.initPaywalls();
        });
    }
    
    async connectWallet() {
        try {
            if (typeof window.ethereum === 'undefined') {
                alert('Please install MetaMask or another Web3 wallet');
                return;
            }
            
            const accounts = await window.ethereum.request({
                method: 'eth_requestAccounts'
            });
            
            if (accounts.length === 0) {
                throw new Error('No accounts found');
            }
            
            this.wallet = accounts[0];
            
            const passport = await this.client.authenticate();
            this.passport = passport;
            
            await this.updateUI();
            await this.syncWithWordPress();
            
            this.showMessage('Wallet connected successfully!', 'success');
            
        } catch (error) {
            console.error('Wallet connection failed:', error);
            this.showMessage('Failed to connect wallet: ' + error.message, 'error');
        }
    }
    
    async syncWithWordPress() {
        try {
            const formData = new FormData();
            formData.append('action', 'opencontext_auth');
            formData.append('nonce', opencontext_ajax.nonce);
            formData.append('wallet_address', this.wallet);
            formData.append('passport_id', this.passport.id);
            
            const response = await fetch(opencontext_ajax.ajax_url, {
                method: 'POST',
                body: formData
            });
            
            const result = await response.json();
            
            if (!result.success) {
                throw new Error(result.data.message || 'Sync failed');
            }
            
        } catch (error) {
            console.error('WordPress sync failed:', error);
        }
    }
    
    async updateUI() {
        const connectBtns = document.querySelectorAll('.opencontext-connect-btn');
        const walletInfos = document.querySelectorAll('.opencontext-wallet-info');
        
        connectBtns.forEach(btn => {
            btn.textContent = 'Connected';
            btn.disabled = true;
            btn.classList.add('connected');
        });
        
        walletInfos.forEach(info => {
            info.style.display = 'block';
            info.querySelector('.wallet-address').textContent = this.shortenAddress(this.wallet);
            info.querySelector('.passport-status').textContent = `Passport #${this.passport.id}`;
        });
    }
    
    async handlePayment(button) {
        try {
            if (!this.wallet) {
                await this.connectWallet();
                return;
            }
            
            const paywall = button.closest('.opencontext-paywall');
            const authorWallet = paywall.dataset.author;
            const rate = parseFloat(paywall.dataset.rate);
            const postId = parseInt(paywall.dataset.post);
            
            button.textContent = 'Starting Payment...';
            button.disabled = true;
            
            await this.client.streamPay(authorWallet, rate);
            
            const formData = new FormData();
            formData.append('action', 'opencontext_stream_pay');
            formData.append('nonce', opencontext_ajax.nonce);
            formData.append('author_wallet', authorWallet);
            formData.append('rate', rate);
            formData.append('post_id', postId);
            
            const response = await fetch(opencontext_ajax.ajax_url, {
                method: 'POST',
                body: formData
            });
            
            const result = await response.json();
            
            if (result.success) {
                paywall.style.display = 'none';
                this.showMessage('Payment started! Content unlocked.', 'success');
                this.trackContentAccess(postId);
            } else {
                throw new Error(result.data.message || 'Payment failed');
            }
            
        } catch (error) {
            console.error('Payment failed:', error);
            this.showMessage('Payment failed: ' + error.message, 'error');
            button.textContent = 'Try Again';
            button.disabled = false;
        }
    }
    
    async trackContentAccess(postId) {
        if (!this.client || !this.passport) return;
        
        try {
            const contextData = {
                postId: postId,
                action: 'premium_access',
                timestamp: Date.now(),
                url: window.location.href
            };
            
            await this.client.storeContext(JSON.stringify(contextData));
            
        } catch (error) {
            console.error('Context tracking failed:', error);
        }
    }
    
    initPaywalls() {
        const paywalls = document.querySelectorAll('.opencontext-paywall');
        
        paywalls.forEach(paywall => {
            if (this.wallet && this.hasActiveStream(paywall.dataset.author)) {
                paywall.style.display = 'none';
            }
        });
    }
    
    hasActiveStream(authorWallet) {
        return false;
    }
    
    async checkExistingConnection() {
        try {
            if (typeof window.ethereum !== 'undefined') {
                const accounts = await window.ethereum.request({
                    method: 'eth_accounts'
                });
                
                if (accounts.length > 0) {
                    this.wallet = accounts[0];
                    
                    try {
                        this.passport = await this.client.getPassport(this.wallet);
                        await this.updateUI();
                    } catch (error) {
                        console.log('No existing passport found');
                    }
                }
            }
        } catch (error) {
            console.error('Failed to check existing connection:', error);
        }
    }
    
    showMessage(message, type = 'info') {
        const notice = document.createElement('div');
        notice.className = `opencontext-notice opencontext-notice-${type}`;
        notice.textContent = message;
        
        document.body.appendChild(notice);
        
        setTimeout(() => {
            notice.remove();
        }, 5000);
    }
    
    shortenAddress(address) {
        if (!address) return '';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
}

class OpenContextTracker {
    static async trackView(postId, title, author) {
        if (!window.openContextWP || !window.openContextWP.client) {
            return;
        }
        
        try {
            const contextData = {
                postId: postId,
                title: title,
                author: author,
                action: 'view',
                timestamp: Date.now(),
                url: window.location.href,
                referrer: document.referrer
            };
            
            await window.openContextWP.client.storeContext(JSON.stringify(contextData));
            
        } catch (error) {
            console.error('View tracking failed:', error);
        }
    }
    
    static async trackEngagement(postId, action, data = {}) {
        if (!window.openContextWP || !window.openContextWP.client) {
            return;
        }
        
        try {
            const contextData = {
                postId: postId,
                action: action,
                data: data,
                timestamp: Date.now(),
                url: window.location.href
            };
            
            await window.openContextWP.client.storeContext(JSON.stringify(contextData));
            
        } catch (error) {
            console.error('Engagement tracking failed:', error);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.openContextWP = new OpenContextWP();
    window.OpenContextTracker = OpenContextTracker;
});

window.addEventListener('scroll', () => {
    const scrollPercent = (window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100;
    
    if (scrollPercent > 50 && !window.openContextScrollTracked) {
        window.openContextScrollTracked = true;
        
        const postId = document.querySelector('[data-post-id]')?.dataset.postId;
        if (postId) {
            OpenContextTracker.trackEngagement(parseInt(postId), 'scroll_50', { percent: 50 });
        }
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        const postId = document.querySelector('[data-post-id]')?.dataset.postId;
        if (postId && window.openContextReadStartTime) {
            const readTime = Date.now() - window.openContextReadStartTime;
            OpenContextTracker.trackEngagement(parseInt(postId), 'read_time', { duration: readTime });
        }
    } else if (document.visibilityState === 'visible') {
        window.openContextReadStartTime = Date.now();
    }
});

if (document.visibilityState === 'visible') {
    window.openContextReadStartTime = Date.now();
}