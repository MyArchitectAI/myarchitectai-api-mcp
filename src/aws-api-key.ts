import { Hash } from '@smithy/hash-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

export type AwsReadCredentials = Readonly<{
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
}>;

/** Only the API Gateway GetApiKey read route is signed; no AWS credential chain or write commands. */
export const signedGetApiKeyRequest = async (
  credentials: AwsReadCredentials,
  awsKeyId: string,
  signingDate: Date,
): Promise<{ url: URL; headers: Record<string, string> }> => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(awsKeyId)) {
    throw new Error('Invalid API Gateway key identifier');
  }
  const host = `apigateway.${credentials.awsRegion}.amazonaws.com`;
  const path = `/apikeys/${awsKeyId}`;
  const signer = new SignatureV4({
    credentials: {
      accessKeyId: credentials.awsAccessKeyId,
      secretAccessKey: credentials.awsSecretAccessKey,
      ...(credentials.awsSessionToken ? { sessionToken: credentials.awsSessionToken } : {}),
    },
    region: credentials.awsRegion,
    service: 'apigateway',
    sha256: Hash.bind(null, 'sha256'),
  });
  const signed = await signer.sign(new HttpRequest({ method: 'GET', protocol: 'https:', hostname: host,
    path, query: { includeValue: 'true' }, headers: { host } }), { signingDate });
  const headers = { ...signed.headers };
  delete headers.host;
  return { url: new URL(`https://${host}${path}?includeValue=true`), headers };
};
