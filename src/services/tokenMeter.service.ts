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
    private companyName: string;
    private userName: string;
    private password: string;

    constructor() {
        this.apiBaseUrl = process.env.STRONPOWER_BASE_URL || 'http://www.server-newv.stronpower.com';
        this.companyName = process.env.STRONPOWER_COMPANY_NAME || '';
        this.userName = process.env.STRONPOWER_USERNAME || '';
        this.password = process.env.STRONPOWER_PASSWORD || '';
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
            const payload = {
                "CompanyName": this.companyName,
                "UserName": this.userName,
                "Password": this.password,
                "MeterNo": params.meterNumber,
                "Amount": params.amount
            };

            const requestHeaders: any = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            };

            console.log("STRONPOWER REQUEST:", payload);

            // If we are in demo mode for this specific meter, simulate success
            const demoMeters = ['399703', '645424'];
            const isDemoMeter = demoMeters.some(dm => params.meterNumber.includes(dm));
            const isDemoEnabled = String(process.env.ENABLE_DEMO_METER).toLowerCase() === 'true';

            if (isDemoMeter && isDemoEnabled) {
                console.warn(`⚠️ [TokenMeter] Simulating Vending success for DEMO meter ${params.meterNumber}`);
                const fakeToken = this.generateLocalToken();
                return {
                    success: true,
                    token: fakeToken,
                    meterNumber: params.meterNumber,
                    amount: params.amount,
                    units: this.calculateUnits(params.amount),
                    apiReference: `DEMO-SP-${Date.now()}`,
                    message: 'Demo Token generated successfully',
                    raw: { demo: true, original_meter: params.meterNumber }
                };
            }

            const response = await axios.post(
                `${this.apiBaseUrl}/api/VendingMeter`,
                payload,
                {
                    headers: requestHeaders,
                    timeout: 20000,
                    validateStatus: (status) => status < 500,
                }
            );

            console.log("STRONPOWER RESPONSE:", response.data);

            if (response.status >= 400) {
                return {
                    success: false,
                    error: response.data?.message || response.data?.error || `API error: HTTP ${response.status}`,
                    raw: response.data
                };
            }

            // Extract the token from the API response
            // Checking specific fields as requested, handling both object and array formats
            const data = Array.isArray(response.data) ? response.data[0] : response.data;

            const extractedToken =
                data?.Token ||
                data?.token ||
                data?.Data?.Token;

            if (extractedToken) {
                return {
                    success: true,
                    token: String(extractedToken),
                    meterNumber: params.meterNumber,
                    amount: params.amount,
                    units: data?.Units || data?.units || this.calculateUnits(params.amount),
                    apiReference: data?.Reference || data?.reference || data?.transaction_id || `SP-${Date.now()}`,
                    message: data?.Message || data?.message || 'Token generated successfully',
                    raw: response.data
                };
            } else {
                // If token missing, return full provider response for debugging
                console.error('[TokenMeter] Token missing in provider response:', JSON.stringify(response.data));
                return {
                    success: false,
                    error: 'Token missing in provider response',
                    raw: response.data
                };
            }
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

        // SPECIAL CASE: Demo/Test meter from user screenshots (Must be checked before API call)
        const demoMeters = ['399703', '645424'];
        const isDemoMeter = demoMeters.some(dm => meterNumber.includes(dm));
        const isDemoEnabled = String(process.env.ENABLE_DEMO_METER).toLowerCase() === 'true';

        if (isDemoMeter && isDemoEnabled) {
            console.warn(`⚠️ [TokenMeter] Using DEMO MODE for meter ${meterNumber}`);
            return { success: true, raw: { demo: true, message: "Bypassed validation via Demo Mode" } };
        }

        try {
            const payload = {
                "CompanyName": this.companyName,
                "UserName": this.userName,
                "Password": this.password,
                "MeterNo": meterNumber
            };

            console.log("STRONPOWER REQUEST (Validation):", payload);
            const response = await axios.post(
                `${this.apiBaseUrl}/api/QueryMeterInfo`,
                payload,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: 10000,
                    validateStatus: (status) => status < 500,
                }
            );

            const data = Array.isArray(response.data) ? response.data[0] : response.data;

            if (response.status >= 400 || (data && (data.error || data.Company_name === 'Data error' || data.CompanyName === 'Data error'))) {
                return {
                    success: false,
                    error: data?.message || data?.error || data?.Company_name || `Meter validation failed (HTTP ${response.status})`,
                    raw: response.data
                };
            }

            // Check if returned data looks like a meter object
            if (!data || (!data.MeterNo && !data.Meter_id && !data.CustomerName && !data.Customer_name)) {
                let errorMsg = 'Invalid meter number or no data found for this meter';
                if (data && data.Meter_type) {
                    errorMsg = `Meter found is an "${data.Meter_type}" (${data.Unit || ''}). Please ensure you are using a Gas Meter number.`;
                }
                return {
                    success: false,
                    error: errorMsg,
                    raw: response.data
                };
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
