import axios from 'axios';
import prisma from '../utils/prisma';

class PalmKashService {
  private clientId: string;
  private secretKey: string;
  private env: string;
  private baseUrl: string;

  constructor() {
    this.clientId = process.env.PALMKASH_CLIENT_ID || '';
    this.secretKey = process.env.PALMKASH_SECRET_KEY || '';
    this.env = process.env.PALMKASH_ENV || 'sandbox';
    this.baseUrl = process.env.PALMKASH_API_URL || 'https://testdashboard.palmkash.com/api';
  }

  /**
   * Get Authentication Token
   */
  private async getAccessToken(): Promise<string> {
    try {
 
      return ""; 
    } catch (error: any) {
      console.error('PalmKash Auth Error:', error.response?.data || error.message);
      throw new Error('Failed to authenticate with PalmKash');
    }
  }

  /**
   * Initiate Mobile Money Payment
   */
  async initiatePayment(params: {
    amount: number;
    phoneNumber: string;
    referenceId: string;
    description: string;
    callbackUrl?: string;
  }) {
 
    const isDev = process.env.DEV_MODE === 'true' || process.env.DEV_MODE === '1';
    console.log(`🔌 [PalmKash] DEV_MODE config: "${process.env.DEV_MODE}", isDev: ${isDev}`);
    
    if (isDev) {
      console.log(`🛠️ [PalmKash DEV MODE] Bypassing real payment for ${params.phoneNumber}, Amount: ${params.amount}`);
      return {
        success: true,
        transactionId: `DEV-TXN-${Date.now()}`,
        status: 'SUCCESS', // Simulate immediate success in DEV_MODE
        message: 'Payment simulated (DEV_MODE active)'
      };
    }

    try {
      // Ensure phone number starts with 250 for Rwanda
      let phone = params.phoneNumber.replace(/\s+/g, ''); // Remove spaces
      if (phone.startsWith('0') && phone.length === 10) {
        phone = '250' + phone.substring(1);
      } else if (phone.length === 9 || phone.length === 10) {
        // If it's a 9 or 10 digit number without 250, add it
        if (!phone.startsWith('250')) {
             phone = '250' + phone;
        }
      }

      console.log(`🚀 [PalmKash] Initiating payment for ${phone}, Amount: ${params.amount}`);

      // Updated Endpoint: /payments/make-payment
      const response = await axios.post(`${this.baseUrl}/payments/make-payment`, {
        app_id: this.clientId,
        app_secret: this.secretKey, 
        amount: params.amount,
        phone_number: phone, 
        reference: params.referenceId,
        description: params.description,
        callback_url: params.callbackUrl || `${process.env.BACKEND_URL}/api/webhooks/palmkash`
      }, {
        headers: {
          'Authorization': `Bearer ${this.secretKey}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/json',
          'Referer': 'https://dashboard.palmkash.com/',
          'Origin': 'https://dashboard.palmkash.com'
        }
      });

      return {
        success: true,
        transactionId: response.data.transaction_id || response.data.reference,
        status: response.data.status, 
        message: response.data.message || 'Payment initiated'
      };
    } catch (error: any) {
      console.error('PalmKash Payment Error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message || 'PalmKash connection failed'
      };
    }
  }

  /**
   * Verify Payment Status
   * Updated Endpoint: /payments/get-payment-status
   */
  async verifyPayment(transactionId: string) {
    try {
      const response = await axios.post(`${this.baseUrl}/payments/get-payment-status`, {
        app_id: this.clientId,
        app_secret: this.secretKey,
        reference: transactionId
      }, {
        headers: {
          'Authorization': `Bearer ${this.secretKey}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'Referer': 'https://dashboard.palmkash.com/',
          'Origin': 'https://dashboard.palmkash.com'
        }
      });
      return response.data; // { status: 'SUCCESS' | 'FAILED' | 'PENDING', ... }
    } catch (error: any) {
      console.error('PalmKash Verify Error:', error.response?.data || error.message);
      return { status: 'ERROR', message: error.message };
    }
  }
}

export default new PalmKashService();
  