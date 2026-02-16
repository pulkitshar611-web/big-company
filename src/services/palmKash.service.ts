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
    this.baseUrl = this.env === 'sandbox' 
      ? 'https://testdashboard.palmkash.com/api' 
      : 'https://api.palmkash.com/v1';
  }

  /**
   * Get Authentication Token
   */
  private async getAccessToken(): Promise<string> {
    try {
      // Assuming standard OAuth or similar if needed, but for now using direct creds in payload as per common gateway patterns
      // If specific auth endpoint is needed, it would be here.
      // For now, returning empty as some gateways use Basic Auth or Payload params
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
    // ==========================================
    // DEV MODE BYPASS
    // Skip real external API calls if in DEV_MODE
    // ==========================================
    // ==========================================
    // DEV MODE BYPASS
    // Skip real external API calls if in DEV_MODE
    // ==========================================
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
      // Ensure phone number starts with 250 for Rwanda if it's 10 digits
      let phone = params.phoneNumber;
      if (phone.startsWith('0') && phone.length === 10) {
        phone = '250' + phone.substring(1);
      }

      console.log(`🚀 [PalmKash] Initiating payment for ${phone}, Amount: ${params.amount}`);

      // Updated Endpoint: /payments/make-payment
      const response = await axios.post(`${this.baseUrl}/payments/make-payment`, {
        app_id: this.clientId,
        app_secret: this.secretKey, // Assuming credentials are passed in body
        amount: params.amount,
        phone_number: phone, // "phone" or "phone_number"? defaulting to phone_number as common
        reference: params.referenceId,
        description: params.description,
        callback_url: params.callbackUrl || `${process.env.BACKEND_URL}/api/webhooks/palmkash`
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
      });
      return response.data; // { status: 'SUCCESS' | 'FAILED' | 'PENDING', ... }
    } catch (error: any) {
      console.error('PalmKash Verify Error:', error.response?.data || error.message);
      return { status: 'ERROR', message: error.message };
    }
  }
}

export default new PalmKashService();
  