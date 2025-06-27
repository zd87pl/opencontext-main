/**
 * OpenContext OAuth Integration - Frontend JavaScript
 * Handles OAuth authentication flow and content encryption
 */

(function($) {
    'use strict';

    // OAuth Integration Class
    window.OpenContextOAuth = {
        
        init: function() {
            this.bindEvents();
            this.checkOAuthStatus();
            this.initEncryptionLibrary();
        },
        
        bindEvents: function() {
            $(document).on('click', '.opencontext-oauth-connect', this.handleOAuthConnect.bind(this));
            $(document).on('click', '.opencontext-oauth-disconnect', this.handleOAuthDisconnect.bind(this));
            $(document).on('click', '.opencontext-sync-content', this.handleContentSync.bind(this));
            $(document).on('click', '.opencontext-encrypt-post', this.handlePostEncryption.bind(this));
            $(document).on('click', '.opencontext-publish-encrypted', this.handleEncryptedPublish.bind(this));
        },
        
        handleOAuthConnect: function(e) {
            e.preventDefault();
            
            const provider = $(e.target).data('provider');
            const $button = $(e.target);
            
            if (!provider) {
                this.showMessage('Please select a provider', 'error');
                return;
            }
            
            $button.prop('disabled', true).text('Connecting...');
            
            $.ajax({
                url: opencontext_oauth.ajax_url,
                type: 'POST',
                data: {
                    action: 'opencontext_oauth_connect',
                    provider: provider,
                    nonce: opencontext_oauth.nonce
                },
                success: function(response) {
                    if (response.success) {
                        // Open OAuth popup
                        const popup = window.open(
                            response.data.oauth_url,
                            'opencontext_oauth',
                            'width=600,height=700,scrollbars=yes,resizable=yes'
                        );
                        
                        // Monitor popup
                        const checkClosed = setInterval(function() {
                            if (popup.closed) {
                                clearInterval(checkClosed);
                                // Refresh page to show updated status
                                window.location.reload();
                            }
                        }, 1000);
                        
                    } else {
                        this.showMessage(response.data || 'OAuth connection failed', 'error');
                    }
                    
                    $button.prop('disabled', false).text('Connect');
                }.bind(this),
                error: function() {
                    this.showMessage('Network error during OAuth connection', 'error');
                    $button.prop('disabled', false).text('Connect');
                }.bind(this)
            });
        },
        
        handleOAuthDisconnect: function(e) {
            e.preventDefault();
            
            if (!confirm('Are you sure you want to disconnect OAuth? This will remove access to synced content.')) {
                return;
            }
            
            const $button = $(e.target);
            $button.prop('disabled', true).text('Disconnecting...');
            
            $.ajax({
                url: opencontext_oauth.ajax_url,
                type: 'POST',
                data: {
                    action: 'opencontext_oauth_disconnect',
                    nonce: opencontext_oauth.nonce
                },
                success: function(response) {
                    if (response.success) {
                        this.showMessage('OAuth disconnected successfully', 'success');
                        setTimeout(() => window.location.reload(), 1500);
                    } else {
                        this.showMessage(response.data || 'Failed to disconnect OAuth', 'error');
                    }
                    
                    $button.prop('disabled', false).text('Disconnect');
                }.bind(this),
                error: function() {
                    this.showMessage('Network error during disconnection', 'error');
                    $button.prop('disabled', false).text('Disconnect');
                }.bind(this)
            });
        },
        
        handleContentSync: function(e) {
            e.preventDefault();
            
            const $button = $(e.target);
            const originalText = $button.text();
            
            $button.prop('disabled', true).text('Syncing...');
            
            $.ajax({
                url: opencontext_oauth.ajax_url,
                type: 'POST',
                data: {
                    action: 'opencontext_sync_content',
                    nonce: opencontext_oauth.nonce
                },
                success: function(response) {
                    if (response.success) {
                        const count = response.data.synced_count;
                        this.showMessage(`Successfully synced ${count} content items`, 'success');
                        
                        // Update content list if exists
                        if (response.data.content && $('#synced-content-list').length) {
                            this.updateContentList(response.data.content);
                        }
                    } else {
                        this.showMessage(response.data || 'Content sync failed', 'error');
                    }
                    
                    $button.prop('disabled', false).text(originalText);
                }.bind(this),
                error: function() {
                    this.showMessage('Network error during content sync', 'error');
                    $button.prop('disabled', false).text(originalText);
                }.bind(this)
            });
        },
        
        handlePostEncryption: function(e) {
            e.preventDefault();
            
            const postId = $(e.target).data('post-id');
            const postContent = this.getPostContent(postId);
            
            if (!postContent) {
                this.showMessage('No content found to encrypt', 'error');
                return;
            }
            
            const $button = $(e.target);
            $button.prop('disabled', true).text('Encrypting...');
            
            this.encryptPostContent(postContent, postId).then(function(encryptedData) {
                // Store encrypted data
                this.storeEncryptedContent(postId, encryptedData);
                this.showMessage('Content encrypted successfully', 'success');
                $button.prop('disabled', false).text('Encrypt Content');
                
                // Show publish options
                $('.opencontext-publish-encrypted').show();
                
            }.bind(this)).catch(function(error) {
                this.showMessage('Encryption failed: ' + error.message, 'error');
                $button.prop('disabled', false).text('Encrypt Content');
            }.bind(this));
        },
        
        handleEncryptedPublish: function(e) {
            e.preventDefault();
            
            const postId = $(e.target).data('post-id');
            const price = $('#opencontext-content-price').val();
            
            if (!price || price <= 0) {
                this.showMessage('Please set a valid price', 'error');
                return;
            }
            
            const $button = $(e.target);
            $button.prop('disabled', true).text('Publishing...');
            
            // Send encrypted content to OpenContext backend
            this.publishToOpenContext(postId, price).then(function(response) {
                this.showMessage('Content published to OpenContext successfully', 'success');
                $button.prop('disabled', false).text('Publish to OpenContext');
                
                // Update post meta
                this.updatePostMeta(postId, {
                    opencontext_published: true,
                    opencontext_content_id: response.contentId,
                    opencontext_price: price
                });
                
            }.bind(this)).catch(function(error) {
                this.showMessage('Publishing failed: ' + error.message, 'error');
                $button.prop('disabled', false).text('Publish to OpenContext');
            }.bind(this));
        },
        
        encryptPostContent: async function(content, postId) {
            if (!window.OpenContextEncryption) {
                throw new Error('Encryption library not loaded');
            }
            
            const metadata = {
                title: $('#title').val() || $('h1.entry-title').text(),
                author: $('#opencontext-author').val() || '',
                price: parseFloat($('#opencontext-content-price').val() || '0.01')
            };
            
            return await window.OpenContextEncryption.encrypt(content, metadata);
        },
        
        publishToOpenContext: async function(postId, price) {
            const encryptedData = this.getStoredEncryptedContent(postId);
            
            if (!encryptedData) {
                throw new Error('No encrypted content found');
            }
            
            const response = await fetch(opencontext_oauth.backend_url + '/api/content/create', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + this.getOAuthToken()
                },
                body: JSON.stringify({
                    title: encryptedData.publicData.title,
                    description: encryptedData.publicData.preview,
                    content: encryptedData.content,
                    platform: 'wordpress',
                    platformId: postId.toString(),
                    price: parseFloat(price)
                })
            });
            
            if (!response.ok) {
                throw new Error('Backend API error: ' + response.statusText);
            }
            
            return await response.json();
        },
        
        getPostContent: function(postId) {
            // Try different ways to get post content
            if ($('#content').length) {
                // WordPress editor
                if (typeof tinymce !== 'undefined' && tinymce.get('content')) {
                    return tinymce.get('content').getContent();
                }
                return $('#content').val();
            }
            
            // Gutenberg editor
            if (typeof wp !== 'undefined' && wp.data && wp.data.select('core/editor')) {
                return wp.data.select('core/editor').getEditedPostContent();
            }
            
            // Frontend content
            if ($('.entry-content').length) {
                return $('.entry-content').html();
            }
            
            return null;
        },
        
        storeEncryptedContent: function(postId, encryptedData) {
            sessionStorage.setItem('opencontext_encrypted_' + postId, JSON.stringify(encryptedData));
        },
        
        getStoredEncryptedContent: function(postId) {
            const stored = sessionStorage.getItem('opencontext_encrypted_' + postId);
            return stored ? JSON.parse(stored) : null;
        },
        
        updatePostMeta: function(postId, meta) {
            $.ajax({
                url: opencontext_oauth.ajax_url,
                type: 'POST',
                data: {
                    action: 'opencontext_update_post_meta',
                    post_id: postId,
                    meta: meta,
                    nonce: opencontext_oauth.nonce
                }
            });
        },
        
        getOAuthToken: function() {
            // This would be stored securely after OAuth connection
            return localStorage.getItem('opencontext_oauth_token') || '';
        },
        
        checkOAuthStatus: function() {
            const $statusElement = $('.opencontext-oauth-status');
            
            if ($statusElement.length) {
                $.ajax({
                    url: opencontext_oauth.ajax_url,
                    type: 'POST',
                    data: {
                        action: 'opencontext_oauth_status',
                        nonce: opencontext_oauth.nonce
                    },
                    success: function(response) {
                        if (response.success && response.data.connected) {
                            $statusElement.html(`
                                <div class="oauth-connected">
                                    <span class="dashicons dashicons-yes-alt"></span>
                                    Connected to ${response.data.provider}
                                    <small>(${response.data.connected_at})</small>
                                </div>
                            `);
                            
                            $('.opencontext-oauth-features').show();
                        } else {
                            $statusElement.html(`
                                <div class="oauth-disconnected">
                                    <span class="dashicons dashicons-dismiss"></span>
                                    Not connected to OpenContext
                                </div>
                            `);
                        }
                    }
                });
            }
        },
        
        updateContentList: function(content) {
            const $list = $('#synced-content-list');
            
            content.forEach(function(item) {
                const $item = $(`
                    <div class="synced-content-item">
                        <h4>${item.title}</h4>
                        <p>Source: ${item.source}</p>
                        <a href="/wp-admin/post.php?post=${item.id}&action=edit" target="_blank">
                            Edit Post
                        </a>
                    </div>
                `);
                
                $list.append($item);
            });
        },
        
        initEncryptionLibrary: function() {
            // Load client-side encryption library
            if (!window.OpenContextEncryption) {
                $.getScript(opencontext_oauth.backend_url + '/api/content/lib/encryption.js')
                    .done(function() {
                        console.log('OpenContext encryption library loaded');
                    })
                    .fail(function() {
                        console.error('Failed to load OpenContext encryption library');
                    });
            }
        },
        
        showMessage: function(message, type) {
            const $message = $(`
                <div class="notice notice-${type} is-dismissible">
                    <p>${message}</p>
                    <button type="button" class="notice-dismiss">
                        <span class="screen-reader-text">Dismiss this notice.</span>
                    </button>
                </div>
            `);
            
            $('.wrap h1').after($message);
            
            // Auto-remove after 5 seconds
            setTimeout(function() {
                $message.fadeOut();
            }, 5000);
            
            // Handle dismiss button
            $message.find('.notice-dismiss').on('click', function() {
                $message.fadeOut();
            });
        }
    };

    // Initialize when document is ready
    $(document).ready(function() {
        if (typeof opencontext_oauth !== 'undefined') {
            window.OpenContextOAuth.init();
        }
    });

})(jQuery);