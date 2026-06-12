import { CustomerPaymentMethod, CustomerRequestType } from '../schemas/customer-request.schema';

export class CreateCustomerRequestDto {
  sessionId: string;
  type: CustomerRequestType;
  message?: string;
  paymentMethod?: CustomerPaymentMethod;
  customerName?: string;
  customerPhone?: string;
}
