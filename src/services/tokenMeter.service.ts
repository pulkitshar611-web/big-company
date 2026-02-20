import axios from 'axios';

/**
 * Token Meter Service
 * 
 * Handles integration with Token-Based Prepaid Gas Meters.
 * Supports LORAWAN and ZL type meters (Rwanda Token APIs).
 * 
 * Flow:
 *  1. Customer pays → calls rechargeTokenMeter()
 *  2. System calls external Token API
 *  3. API returns a prepaid token string
 *  4. Token is stored in DB and returned to customer for meter input
 */

export interface TokenMeterRechargeParams {
    meterNumber: string;
    amount: number;       // Amount in RWF
    customerRef: string;  // Internal reference for tracking
}

export interface TokenMeterRechargeResult {
    success: boolean;
    token?: string;          // Generated prepaid token (e.g. "1234-5678-9012-3456")
    meterNumber?: string;
    amount?: number;
    units?: number;
    apiReference?: string;   // External API's transaction ID
    message?: string;
    error?: string;
    raw?: any;               // Full provider response
}

class TokenMeterService {
    // These environment variables should be set per the API documentation
    private apiBaseUrl: string;
    private apiKey: string;
    private merchantCode: string;
    private companyName: string;
    private userName: string;
    private stronpowerApiKey: string;

    constructor() {
        this.apiBaseUrl = process.env.TOKEN_METER_API_URL || 'http://www.server-newv.stronpower.com';
        this.apiKey = process.env.TOKEN_METER_API_KEY || '';
        this.merchantCode = process.env.TOKEN_METER_MERCHANT_CODE || '';
        this.companyName = process.env.STRONPOWER_COMPANY_NAME || '';
        this.userName = process.env.STRONPOWER_USERNAME || '';
        this.stronpowerApiKey = process.env.STRONPOWER_API_KEY || '';
    }

    /**
     * Main public method: recharge a token meter by calling external API.
     * The API returns a 20-digit STS standard token that the customer enters into their meter.
     */
    async rechargeTokenMeter(params: TokenMeterRechargeParams): Promise<TokenMeterRechargeResult> {
        const isDev = process.env.DEV_MODE === 'true' || process.env.DEV_MODE === '1';

        if (isDev) {
            // In DEV mode, simulate a successful token response
            console.log(`🛠️ [TokenMeter DEV MODE] Simulating token for meter: ${params.meterNumber}, Amount: ${params.amount}`);
            const fakeToken = this.generateLocalToken();
            const units = this.calculateUnits(params.amount);
            return {
                success: true,
                token: fakeToken,
                meterNumber: params.meterNumber,
                amount: params.amount,
                units,
                apiReference: `DEV-TOKEN-${Date.now()}`,
                message: `Token generated (DEV_MODE). Enter into meter: ${fakeToken}`
            };
        }

        try {
            // STEP 1: Validate Meter before vending
            const validation = await this.validateMeter(params.meterNumber);
            if (!validation.success) {
                return {
                    success: false,
                    error: validation.error || 'Meter validation failed. Please check the meter number.',
                    meterNumber: params.meterNumber,
                    raw: validation.raw
                };
            }
            console.log(`[TokenMeter] Meter ${params.meterNumber} validated successfully.`);

            // STEP 2: Proceed to Recharge
            const requestBody = {
                "CompanyName": this.companyName,
                "UserName": this.userName,
                "MeterNo": params.meterNumber,
                "Amount": params.amount
            };

            const requestHeaders: any = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            };

            if (this.stronpowerApiKey) {
                requestHeaders['api_key'] = this.stronpowerApiKey;
            }

            console.log(`🚀 [TokenMeter] Requesting token for meter ${params.meterNumber}, Amount: ${params.amount}`);
            console.log('[TokenMeter] Request body:', JSON.stringify(requestBody, null, 2));

            const response = await axios.post(
                `${this.apiBaseUrl}/api/VendingMeter`,
                requestBody,
                {
                    headers: requestHeaders,
                    timeout: 20000,
                    validateStatus: (status) => status < 500,
                }
            );

            console.log(`[TokenMeter] Response status: ${response.status}`);
            console.log('[TokenMeter] Response data:', JSON.stringify(response.data, null, 2));

            if (response.status >= 400) {
                return {
                    success: false,
                    error: response.data?.message || response.data?.error || `API error: HTTP ${response.status}`,
                    raw: response.data
                };
            }

            console.log("STRONPOWER RAW RESPONSE:", JSON.stringify(response.data, null, 2));

            // Parse the token from the API response
            // Checking multiple possible casing/nesting scenarios for Stronpower
            const token =
                response.data?.Token ||
                response.data?.token ||
                response.data?.Data?.Token ||
                response.data?.Result?.Token ||
                response.data?.data?.token ||
                response.data?.prepaid_token ||
                response.data?.recharge_code;

            if (!token) {
                console.error('[TokenMeter] Token missing in provider response:', JSON.stringify(response.data));
                return {
                    success: false,
                    error: 'Token missing in provider response',
                    raw: response.data
                };
            }

            const units = response.data?.Units || response.data?.units || this.calculateUnits(params.amount);

            return {
                success: true,
                token: String(token),
                meterNumber: params.meterNumber,
                amount: params.amount,
                units,
                apiReference: response.data?.Reference || response.data?.reference || response.data?.transaction_id || `SP-${Date.now()}`,
                message: response.data?.Message || response.data?.message || 'Token generated successfully',
                raw: response.data
            };
        } catch (error: any) {
            console.error('[TokenMeter] API Error:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message || 'Failed to connect to Token Meter API',
                raw: error.response?.data
            };
        }
    }

    /**
     * Calculate approximate gas units for a given RWF amount.
     * Rate: 1 kg of LPG = 1,500 RWF (standardized Rwanda rate).
     */
    private calculateUnits(amountRwf: number): number {
        return parseFloat((amountRwf / 1500).toFixed(4));
    }

    /**
     * Generate a local simulated 20-digit STS token for DEV mode.
     * Groups of 5 digits separated by spaces, matching standard meter token format.
     */
    private generateLocalToken(): string {
        const digits = Array.from({ length: 20 }, () => Math.floor(Math.random() * 10)).join('');
        return digits.replace(/(\d{5})/g, '$1 ').trim();
    }
    /**
     * Validate the meter number with the provider API.
     */
    async validateMeter(meterNumber: string): Promise<{ success: boolean; error?: string; raw?: any }> {
        // Skip validation in DEV mode
        const isDev = process.env.DEV_MODE === 'true' || process.env.DEV_MODE === '1';
        if (isDev) {
            console.log(`🛠️ [TokenMeter DEV MODE] Skipping validation for meter: ${meterNumber}`);
            return { success: true };
        }

        try {
            console.log(`🔍 [TokenMeter] Validating meter ${meterNumber}...`);
            const response = await axios.post(
                `${this.apiBaseUrl}/api/QueryMeterInfo`,
                {
                    "CompanyName": this.companyName,
                    "UserName": this.userName,
                    "MeterNo": meterNumber
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        ...(this.stronpowerApiKey ? { 'api_key': this.stronpowerApiKey } : {})
                    },
                    timeout: 10000,
                    validateStatus: (status) => status < 500,
                }
            );

            // Stronpower typically returns the meter info if valid, or an error message if invalid.
            // If the response contains a valid meter number or customer info, we assume it's valid.
            // Based on prompt "If meter is invalid, return error immediately", we trust the API response.

            console.log(`[TokenMeter] Validation response fo ${meterNumber}:`, JSON.stringify(response.data));

            if (response.status >= 400 || (response.data && response.data.error)) {
                return {
                    success: false,
                    error: response.data?.message || response.data?.error || `Meter validation failed (HTTP ${response.status})`,
                    raw: response.data
                };
            }

            // Some APIs return success=false in 200 OK
            if (response.data?.success === false) {
                return {
                    success: false,
                    error: response.data?.message || 'Meter validation failed at provider',
                    raw: response.data
                };
            }

            // Check if returned data looks like a meter object
            // If the API returns a "MeterNo" or "CustomerName" it's likely valid.
            // If it returns null or empty object, treating as invalid might be safer, but let's be permissive if status is 200 unless clearly empty.
            if (!response.data) {
                return { success: false, error: 'Empty response from meter validation API', raw: response.data };
            }

            return { success: true, raw: response.data };

        } catch (error: any) {
            console.error('[TokenMeter] Validation Error:', error.message);
            // If we can't validate (network error), strictly speaking we should fail? 
            // Requirements say: "If meter is invalid, return error immediately."
            // If network fails, we can't be sure. Retrying or failing is safe. Failing is safer.
            return {
                success: false,
                error: `Meter validation error: ${error.message}`,
                raw: error.response?.data
            };
        }
    }
}

export default new TokenMeterService();
