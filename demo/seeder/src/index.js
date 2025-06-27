const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const faker = require('faker');
const fs = require('fs');
const path = require('path');

// Configuration
const BACKEND_URL = process.env.BACKEND_URL || 'http://backend:3001';
const DEMO_USERS_COUNT = parseInt(process.env.DEMO_USERS_COUNT) || 10;
const DEMO_CONTENT_COUNT = parseInt(process.env.DEMO_CONTENT_COUNT) || 50;
const DEMO_PURCHASES_COUNT = parseInt(process.env.DEMO_PURCHASES_COUNT) || 100;

// Demo data
const DEMO_PLATFORMS = ['wordpress', 'medium', 'github', 'static'];
const SAMPLE_CONTENT = [
  {
    title: 'The Future of Web3 Identity',
    content: 'In the rapidly evolving landscape of Web3, identity management has become a critical component...',
    category: 'Technology'
  },
  {
    title: 'Decentralized Content Monetization',
    content: 'Content creators have long struggled with fair compensation for their work. Traditional platforms...',
    category: 'Finance'
  },
  {
    title: 'AI Agents and Human-AI Collaboration',
    content: 'As artificial intelligence becomes more sophisticated, the relationship between humans and AI...',
    category: 'AI'
  },
  {
    title: 'Privacy-First Data Management',
    content: 'Data privacy has become paramount in our digital age. With increasing concerns about...',
    category: 'Privacy'
  },
  {
    title: 'The Economics of Micropayments',
    content: 'Micropayments represent a fundamental shift in how we think about digital transactions...',
    category: 'Economics'
  }
];

class DemoSeeder {
  constructor() {
    this.users = [];
    this.content = [];
    this.purchases = [];
    this.authTokens = new Map();
  }

  async seed() {
    console.log('🌱 Starting OpenContext demo data seeding...');
    
    try {
      // Wait for backend to be ready
      await this.waitForBackend();
      
      // Seed users
      console.log(`👥 Creating ${DEMO_USERS_COUNT} demo users...`);
      await this.seedUsers();
      
      // Seed content
      console.log(`📝 Creating ${DEMO_CONTENT_COUNT} demo content items...`);
      await this.seedContent();
      
      // Seed purchases
      console.log(`💰 Creating ${DEMO_PURCHASES_COUNT} demo purchases...`);
      await this.seedPurchases();
      
      // Save seed data
      await this.saveSeedData();
      
      console.log('✅ Demo seeding completed successfully!');
      console.log('📊 Seed Summary:');
      console.log(`   Users: ${this.users.length}`);
      console.log(`   Content: ${this.content.length}`);
      console.log(`   Purchases: ${this.purchases.length}`);
      
    } catch (error) {
      console.error('❌ Seeding failed:', error);
      process.exit(1);
    }
  }

  async waitForBackend() {
    console.log('⏳ Waiting for backend to be ready...');
    
    let retries = 30;
    while (retries > 0) {
      try {
        const response = await axios.get(`${BACKEND_URL}/health`);
        if (response.status === 200) {
          console.log('✅ Backend is ready');
          return;
        }
      } catch (error) {
        console.log(`🔄 Backend not ready, retrying... (${retries} attempts left)`);
        await this.sleep(2000);
        retries--;
      }
    }
    
    throw new Error('Backend did not become ready in time');
  }

  async seedUsers() {
    for (let i = 0; i < DEMO_USERS_COUNT; i++) {
      const userData = {
        email: faker.internet.email(),
        name: faker.name.findName(),
        avatar: faker.internet.avatar(),
        provider: faker.random.arrayElement(['google', 'github', 'demo']),
        providerId: uuidv4()
      };
      
      try {
        // Create user via OAuth simulation
        const response = await axios.post(`${BACKEND_URL}/auth/demo/create-user`, userData);
        
        if (response.data.success) {
          const user = response.data.user;
          this.users.push(user);
          this.authTokens.set(user.id, response.data.token);
          
          console.log(`   ✓ Created user: ${user.name} (${user.email})`);
        }
      } catch (error) {
        console.log(`   ✗ Failed to create user: ${userData.name}`);
      }
    }
  }

  async seedContent() {
    for (let i = 0; i < DEMO_CONTENT_COUNT; i++) {
      const user = faker.random.arrayElement(this.users);
      const sampleContent = faker.random.arrayElement(SAMPLE_CONTENT);
      
      const contentData = {
        title: `${sampleContent.title} - ${faker.lorem.words(3)}`,
        description: faker.lorem.paragraph(),
        content: `${sampleContent.content}\n\n${faker.lorem.paragraphs(3, '\n\n')}`,
        platform: faker.random.arrayElement(DEMO_PLATFORMS),
        platformId: uuidv4(),
        price: parseFloat(faker.commerce.price(0.5, 10, 2))
      };
      
      try {
        const response = await axios.post(
          `${BACKEND_URL}/content/create`,
          contentData,
          {
            headers: {
              'Authorization': `Bearer ${this.authTokens.get(user.id)}`
            }
          }
        );
        
        if (response.data.success) {
          const content = response.data.content;
          this.content.push({
            ...content,
            userId: user.id,
            authorName: user.name
          });
          
          console.log(`   ✓ Created content: ${content.title}`);
        }
      } catch (error) {
        console.log(`   ✗ Failed to create content: ${contentData.title}`);
      }
    }
  }

  async seedPurchases() {
    for (let i = 0; i < DEMO_PURCHASES_COUNT; i++) {
      const buyer = faker.random.arrayElement(this.users);
      const content = faker.random.arrayElement(this.content);
      
      // Don't let users buy their own content
      if (buyer.id === content.userId) continue;
      
      const purchaseData = {
        contentId: content.id,
        paymentMethod: 'demo',
        amount: content.price
      };
      
      try {
        const response = await axios.post(
          `${BACKEND_URL}/payments/create-intent`,
          purchaseData,
          {
            headers: {
              'Authorization': `Bearer ${this.authTokens.get(buyer.id)}`
            }
          }
        );
        
        if (response.data.success) {
          // Simulate payment completion
          await axios.post(
            `${BACKEND_URL}/payments/demo/complete-purchase`,
            {
              purchaseId: response.data.purchase.id,
              paymentIntentId: response.data.paymentIntentId
            },
            {
              headers: {
                'Authorization': `Bearer ${this.authTokens.get(buyer.id)}`
              }
            }
          );
          
          this.purchases.push({
            id: response.data.purchase.id,
            contentId: content.id,
            buyerId: buyer.id,
            amount: content.price,
            status: 'COMPLETED'
          });
          
          console.log(`   ✓ Created purchase: ${buyer.name} bought "${content.title}"`);
        }
      } catch (error) {
        console.log(`   ✗ Failed to create purchase for content: ${content.title}`);
      }
    }
  }

  async saveSeedData() {
    const seedData = {
      users: this.users,
      content: this.content,
      purchases: this.purchases,
      timestamp: new Date().toISOString(),
      summary: {
        totalUsers: this.users.length,
        totalContent: this.content.length,
        totalPurchases: this.purchases.length,
        totalRevenue: this.purchases.reduce((sum, p) => sum + p.amount, 0)
      }
    };
    
    const dataPath = '/data/seed-data.json';
    fs.writeFileSync(dataPath, JSON.stringify(seedData, null, 2));
    console.log(`📊 Seed data saved to ${dataPath}`);
    
    // Also save demo login tokens for testing
    const loginData = {
      demoUsers: this.users.map(user => ({
        id: user.id,
        email: user.email,
        name: user.name,
        token: this.authTokens.get(user.id)
      }))
    };
    
    const loginPath = '/data/demo-logins.json';
    fs.writeFileSync(loginPath, JSON.stringify(loginData, null, 2));
    console.log(`🔑 Demo login tokens saved to ${loginPath}`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Run seeder
const seeder = new DemoSeeder();
seeder.seed();