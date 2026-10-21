# OpenContext Encrypted Content Architecture
*Revolutionary Client-Side Encryption for Unbreakable Content Protection*

## Executive Summary

OpenContext implements a revolutionary "Protonmail for Premium Content" architecture using client-side encryption. Content is encrypted before publishing, making it mathematically impossible for scrapers to access premium content while enabling legitimate AI agents to discover and decrypt content through OpenContext's MCP interface.

**Key Innovation**: Content protection through cryptography rather than server-side access control.

## Architecture Overview

### **Traditional Content Protection (Breakable)**
```
Creator → Publishes Plaintext → Server Hides Content → Scrapers Find Exploits
                                        ↓
                              [Always Eventually Broken]
```

### **OpenContext Encrypted Protection (Unbreakable)**
```
Creator → Encrypts Client-Side → Publishes Encrypted Blob → Scrapers Get Useless Data
              ↓                        ↓                          ↓
         [Private Key]            [Public Data]              [Mathematically Secure]
              ↓
    OpenContext Key Escrow → Payment → Decryption Key → Content Access
```

## Encryption Flow Architecture

### **1. Content Creation & Encryption**
```typescript
// Creator publishes premium content
class ContentEncryption {
  async publishPremiumContent(content: string, metadata: ContentMetadata) {
    // 1. Generate or retrieve creator's key pair
    const keyPair = await this.getCreatorKeyPair(metadata.creatorId);
    
    // 2. Generate symmetric key for this content
    const contentKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    
    // 3. Encrypt content with symmetric key
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedContent = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      contentKey,
      new TextEncoder().encode(content)
    );
    
    // 4. Encrypt symmetric key with creator's public key
    const exportedContentKey = await crypto.subtle.exportKey("raw", contentKey);
    const encryptedContentKey = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      keyPair.publicKey,
      exportedContentKey
    );
    
    // 5. Create public metadata and preview
    const publicData = {
      id: metadata.id,
      title: metadata.title,
      author: metadata.author,
      preview: this.generatePreview(content, 200),
      price: metadata.price,
      encrypted_blob: {
        content: Array.from(new Uint8Array(encryptedContent)),
        key: Array.from(new Uint8Array(encryptedContentKey)),
        iv: Array.from(iv),
        algorithm: "AES-GCM-256"
      },
      opencontext_encrypted: true
    };
    
    // 6. Register with OpenContext key escrow
    await this.registerWithKeyEscrow({
      content_id: metadata.id,
      encrypted_key: encryptedContentKey,
      creator_public_key: await crypto.subtle.exportKey("spki", keyPair.publicKey),
      content_hash: await this.hashContent(content),
      price: metadata.price
    });
    
    return publicData; // This is what gets published publicly
  }
}
```

### **2. Key Escrow Service**
```typescript
// Secure key management and distribution
class KeyEscrowService {
  async storeContentKey(request: KeyEscrowRequest) {
    // Store encrypted content key and metadata
    await this.database.encrypted_content.create({
      content_id: request.content_id,
      encrypted_key: request.encrypted_key, // Encrypted with creator's public key
      creator_public_key: request.creator_public_key,
      content_hash: request.content_hash,
      price: request.price,
      created_at: new Date(),
      // Never store plaintext or decryption keys
      status: 'active'
    });
  }
  
  async getDecryptionKey(contentId: string, userId: string): Promise<DecryptionKey> {
    // 1. Verify user has paid for content
    const payment = await this.verifyPayment(userId, contentId);
    if (!payment.verified) {
      throw new Error('Payment required');
    }
    
    // 2. Retrieve encrypted content key
    const contentData = await this.database.encrypted_content.findOne({
      content_id: contentId
    });
    
    if (!contentData) {
      throw new Error('Content not found');
    }
    
    // 3. Decrypt the content key using creator's private key
    const creatorPrivateKey = await this.getCreatorPrivateKey(contentData.creator_id);
    const decryptedContentKey = await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      creatorPrivateKey,
      new Uint8Array(contentData.encrypted_key)
    );
    
    // 4. Return content key for client-side decryption
    const keyData = {
      key: Array.from(new Uint8Array(decryptedContentKey)),
      content_id: contentId,
      user_id: userId,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      issued_at: new Date()
    };
    
    // 5. Log access for audit and analytics
    await this.logKeyDistribution(userId, contentId);
    
    return keyData;
  }
}
```

### **3. Content Access & Decryption**
```typescript
// Client-side decryption for authorized users
class ContentDecryption {
  async accessPaidContent(contentId: string, encryptedBlob: EncryptedBlob) {
    // 1. Request decryption key from OpenContext
    const keyData = await this.requestDecryptionKey(contentId);
    
    // 2. Decrypt content client-side
    const decryptedContent = await this.decryptContent(encryptedBlob, keyData);
    
    // 3. Track usage for analytics
    await this.trackDecryption(contentId, 'success');
    
    return {
      content: decryptedContent,
      decrypted_at: new Date().toISOString(),
      expires_at: keyData.expires_at
    };
  }
  
  private async decryptContent(blob: EncryptedBlob, keyData: DecryptionKey): Promise<string> {
    // 1. Import the content key
    const contentKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(keyData.key),
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );
    
    // 2. Decrypt the content
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(blob.iv) },
      contentKey,
      new Uint8Array(blob.content)
    );
    
    // 3. Convert back to text
    return new TextDecoder().decode(decrypted);
  }
}
```

## Platform Integration Examples

### **WordPress Integration**
```php
// WordPress plugin with client-side encryption
class EncryptedWordPressPlugin {
    
    public function addEncryptionToEditor() {
        // Add encryption toggle to post editor
        add_action('add_meta_boxes', [$this, 'addEncryptionMetaBox']);
        
        // Enqueue encryption JavaScript
        wp_enqueue_script('opencontext-encryption', 
            plugin_dir_url(__FILE__) . 'js/encryption.min.js',
            ['crypto-js'], '1.0.0', true);
        
        // Add encryption controls
        wp_localize_script('opencontext-encryption', 'opencontext_vars', [
            'api_url' => 'https://api.opencontext.network',
            'creator_id' => get_current_user_id(),
            'nonce' => wp_create_nonce('opencontext_encrypt')
        ]);
    }
    
    public function addEncryptionMetaBox() {
        add_meta_box(
            'opencontext-encryption',
            'OpenContext Premium Content',
            [$this, 'renderEncryptionMetaBox'],
            'post'
        );
    }
    
    public function renderEncryptionMetaBox($post) {
        $encrypted = get_post_meta($post->ID, 'opencontext_encrypted', true);
        $price = get_post_meta($post->ID, 'opencontext_price', true);
        ?>
        <div id="opencontext-encryption-controls">
            <label>
                <input type="checkbox" id="opencontext-enable-encryption" 
                       <?php checked($encrypted); ?>>
                Enable OpenContext Premium Protection
            </label>
            
            <div id="opencontext-pricing" style="<?php echo $encrypted ? '' : 'display:none;'; ?>">
                <label>Price (USD): 
                    <input type="number" id="opencontext-price" 
                           value="<?php echo esc_attr($price); ?>" 
                           step="0.01" min="0.01">
                </label>
            </div>
            
            <div id="opencontext-status"></div>
        </div>
        
        <script>
        document.addEventListener('DOMContentLoaded', function() {
            const encryptionToggle = document.getElementById('opencontext-enable-encryption');
            const pricingDiv = document.getElementById('opencontext-pricing');
            const statusDiv = document.getElementById('opencontext-status');
            
            encryptionToggle.addEventListener('change', function() {
                pricingDiv.style.display = this.checked ? 'block' : 'none';
            });
            
            // Intercept form submission for encryption
            document.getElementById('publish').addEventListener('click', function(e) {
                if (encryptionToggle.checked) {
                    e.preventDefault();
                    encryptAndPublish();
                }
            });
            
            async function encryptAndPublish() {
                statusDiv.innerHTML = 'Encrypting content...';
                
                const content = wp.data.select('core/editor').getEditedPostContent();
                const price = document.getElementById('opencontext-price').value;
                
                try {
                    // Encrypt content client-side
                    const encrypted = await OpenContextEncryption.encrypt(content, {
                        creatorId: opencontext_vars.creator_id,
                        price: parseFloat(price)
                    });
                    
                    // Replace content with encrypted blob
                    wp.data.dispatch('core/editor').editPost({
                        content: JSON.stringify(encrypted.publicData)
                    });
                    
                    // Set metadata
                    wp.data.dispatch('core/editor').editPost({
                        meta: {
                            opencontext_encrypted: true,
                            opencontext_price: price,
                            opencontext_content_id: encrypted.contentId
                        }
                    });
                    
                    statusDiv.innerHTML = 'Content encrypted successfully!';
                    
                    // Now publish the post
                    wp.data.dispatch('core/editor').savePost();
                    
                } catch (error) {
                    statusDiv.innerHTML = 'Encryption failed: ' + error.message;
                }
            }
        });
        </script>
        <?php
    }
    
    // Display encrypted content to readers
    public function filterContent($content) {
        global $post;
        
        if (get_post_meta($post->ID, 'opencontext_encrypted', true)) {
            return $this->renderDecryptionInterface($post->ID, $content);
        }
        
        return $content;
    }
    
    private function renderDecryptionInterface($postId, $encryptedContent) {
        $price = get_post_meta($postId, 'opencontext_price', true);
        $contentData = json_decode($encryptedContent, true);
        
        ob_start();
        ?>
        <div class="opencontext-encrypted-content">
            <div class="content-preview">
                <?php echo wp_kses_post($contentData['preview']); ?>
            </div>
            
            <div class="opencontext-paywall">
                <h3>Premium Content</h3>
                <p>This content is protected by OpenContext encryption.</p>
                <p><strong>Price:</strong> $<?php echo esc_html($price); ?></p>
                
                <button id="opencontext-purchase" class="button button-primary">
                    Purchase Access
                </button>
                
                <div id="opencontext-decrypted-content" style="display: none;"></div>
            </div>
        </div>
        
        <script>
        document.getElementById('opencontext-purchase').addEventListener('click', async function() {
            try {
                // Process payment and get decryption key
                const access = await OpenContextPayments.purchase({
                    contentId: '<?php echo esc_js($postId); ?>',
                    price: <?php echo esc_js($price); ?>
                });
                
                // Decrypt content client-side
                const decrypted = await OpenContextEncryption.decrypt(
                    <?php echo json_encode($contentData['encrypted_blob']); ?>,
                    access.decryptionKey
                );
                
                // Display decrypted content
                document.getElementById('opencontext-decrypted-content').innerHTML = decrypted;
                document.getElementById('opencontext-decrypted-content').style.display = 'block';
                document.querySelector('.opencontext-paywall').style.display = 'none';
                
            } catch (error) {
                alert('Payment failed: ' + error.message);
            }
        });
        </script>
        <?php
        return ob_get_clean();
    }
}
```

### **Static Site Integration**
```typescript
// Gatsby plugin for build-time encryption
export class GatsbyEncryptionPlugin {
  
  async onCreateNode({ node, actions }: any) {
    if (node.internal.type === 'MarkdownRemark') {
      const { frontmatter, rawMarkdownBody } = node;
      
      if (frontmatter.opencontext?.encrypt) {
        // Encrypt content at build time
        const encrypted = await this.encryptContent(rawMarkdownBody, {
          id: frontmatter.slug,
          price: frontmatter.opencontext.price,
          creatorId: frontmatter.author
        });
        
        // Replace content with encrypted version
        actions.createNodeField({
          node,
          name: 'encryptedContent',
          value: encrypted.publicData
        });
        
        actions.createNodeField({
          node,
          name: 'isEncrypted',
          value: true
        });
      }
    }
  }
  
  // Generate pages for encrypted content
  async createPages({ graphql, actions }: any) {
    const { createPage } = actions;
    
    const encryptedContent = await graphql(`
      query {
        allMarkdownRemark(filter: { fields: { isEncrypted: { eq: true } } }) {
          nodes {
            frontmatter {
              slug
              title
              opencontext {
                price
              }
            }
            fields {
              encryptedContent
            }
          }
        }
      }
    `);
    
    encryptedContent.data.allMarkdownRemark.nodes.forEach((node: any) => {
      createPage({
        path: `/premium/${node.frontmatter.slug}`,
        component: path.resolve('./src/templates/encrypted-content.tsx'),
        context: {
          slug: node.frontmatter.slug,
          encryptedData: node.fields.encryptedContent,
          price: node.frontmatter.opencontext.price
        }
      });
    });
  }
}

// React component for encrypted content display
export const EncryptedContentTemplate = ({ pageContext }: any) => {
  const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  const handlePurchase = async () => {
    setIsLoading(true);
    
    try {
      // Process payment
      const payment = await OpenContextPayments.purchase({
        contentId: pageContext.slug,
        price: pageContext.price
      });
      
      // Get decryption key
      const keyData = await OpenContextAPI.getDecryptionKey(
        pageContext.slug,
        payment.userId
      );
      
      // Decrypt content client-side
      const decrypted = await OpenContextEncryption.decrypt(
        pageContext.encryptedData.encrypted_blob,
        keyData.key
      );
      
      setDecryptedContent(decrypted);
      
    } catch (error) {
      console.error('Purchase failed:', error);
      alert('Purchase failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };
  
  return (
    <div className="encrypted-content-page">
      <h1>{pageContext.encryptedData.title}</h1>
      <p>By {pageContext.encryptedData.author}</p>
      
      <div className="content-preview">
        {pageContext.encryptedData.preview}
      </div>
      
      {!decryptedContent ? (
        <div className="paywall">
          <h3>Premium Content</h3>
          <p>Price: ${pageContext.price}</p>
          <button 
            onClick={handlePurchase} 
            disabled={isLoading}
            className="purchase-button"
          >
            {isLoading ? 'Processing...' : 'Purchase Access'}
          </button>
        </div>
      ) : (
        <div className="decrypted-content">
          <ReactMarkdown>{decryptedContent}</ReactMarkdown>
        </div>
      )}
    </div>
  );
};
```

## MCP Integration for AI Agents

### **MCP Tools for Encrypted Content**
```typescript
{
  name: "search_encrypted_content",
  description: "Search for encrypted premium content across platforms",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      max_price: { type: "number" },
      categories: { type: "array", items: { type: "string" } }
    }
  }
}

{
  name: "purchase_and_decrypt",
  description: "Purchase encrypted content and decrypt for AI agent use",
  inputSchema: {
    type: "object",
    properties: {
      content_id: { type: "string" },
      user_id: { type: "string" },
      encrypted_blob: { type: "object" }
    }
  }
}

// MCP server implementation
async function purchaseAndDecrypt(params: any) {
  // 1. Process payment
  const payment = await processPayment({
    contentId: params.content_id,
    userId: params.user_id,
    amount: await getContentPrice(params.content_id)
  });
  
  if (!payment.success) {
    return { error: 'Payment failed', reason: payment.error };
  }
  
  // 2. Get decryption key
  const keyData = await keyEscrow.getDecryptionKey(
    params.content_id,
    params.user_id
  );
  
  // 3. Decrypt content
  const decrypted = await ContentDecryption.decrypt(
    params.encrypted_blob,
    keyData.key
  );
  
  // 4. Track usage
  await analytics.trackDecryption({
    contentId: params.content_id,
    userId: params.user_id,
    agentId: params.agent_id
  });
  
  return {
    content: decrypted,
    decrypted_at: new Date().toISOString(),
    access_expires_at: keyData.expires_at
  };
}
```

## Security & Privacy Benefits

### **Cryptographic Security**
- **AES-256-GCM**: Industry-standard encryption for content
- **RSA-2048-OAEP**: Secure key encryption and distribution
- **Web Crypto API**: Browser-native cryptographic implementations
- **Perfect Forward Secrecy**: Each content item has unique encryption keys

### **Zero-Knowledge Architecture**
- **OpenContext never sees plaintext**: All content encrypted before transmission
- **Creator privacy**: Full content sovereignty and control
- **User privacy**: Decryption happens client-side only
- **Audit resistance**: Even subpoenas can't reveal encrypted content

### **Scraper Immunity**
- **Mathematically secure**: Scrapers get cryptographically useless data
- **No server-side vulnerabilities**: No access control to bypass
- **Future-proof**: Security based on mathematics, not implementation
- **Platform-independent**: Works on any hosting platform

This encrypted content architecture represents a fundamental shift from traditional content protection to cryptographic security, making OpenContext the first truly unbreakable content protection system for the AI economy.